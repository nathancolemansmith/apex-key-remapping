/**
 * Runs the Lambda handler on your machine, over plain HTTP.
 *
 * The handler is a pure function from an API Gateway event to a response, so
 * nothing about it needs AWS. What AWS supplies in production is three things
 * this file stands in for:
 *
 *   1. **HTTP → event translation**, which API Gateway does.
 *   2. **A verified `sub` claim**, which the JWT authorizer attaches before
 *      the function is ever invoked.
 *   3. **DynamoDB**, which here is DynamoDB Local in a container.
 *
 * The first and third are faithful. The second is not, and deliberately so —
 * see `resolveSub` below.
 *
 *   npm run dev:ddb          # once, in another terminal
 *   npm run dev:serverless
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  CreateTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  ResourceNotFoundException,
} from "@aws-sdk/client-dynamodb";

const PORT = Number(process.env.PORT ?? 3000);
const TABLE_NAME = process.env.TABLE_NAME ?? "apex-layouts-local";
const ENDPOINT = process.env.DDB_ENDPOINT ?? "http://localhost:8000";

// Set before the handler is imported: it builds its repository at module
// scope, so these have to be in place first.
process.env.TABLE_NAME = TABLE_NAME;
process.env.AWS_ENDPOINT_URL_DYNAMODB = ENDPOINT;
process.env.AWS_REGION ??= "us-east-1";
// DynamoDB Local accepts any credentials but the SDK refuses to send a
// request without some.
process.env.AWS_ACCESS_KEY_ID ??= "local";
process.env.AWS_SECRET_ACCESS_KEY ??= "local";

const client = new DynamoDBClient({ endpoint: ENDPOINT });

/**
 * Stands in for the API Gateway JWT authorizer.
 *
 * **This does not verify anything.** It reads the `sub` out of the token's
 * payload without checking the signature, the issuer or the expiry. That is
 * safe here only because this server binds to localhost and is never
 * deployed — but it does mean a local pass proves the *handler* is correct,
 * not that authentication is.
 *
 * It accepts `X-Dev-User` too, which is how the .NET API identifies callers
 * in development. Same shape of lie, same place in the flow, so the two local
 * experiences match.
 */
function resolveSub(request: IncomingMessage): string | undefined {
  const devUser = request.headers["x-dev-user"];
  if (typeof devUser === "string" && devUser.trim()) return devUser.trim();

  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) return undefined;

  try {
    const payload = authorization.slice("Bearer ".length).split(".")[1];
    if (!payload) return undefined;
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return typeof claims.sub === "string" ? claims.sub : undefined;
  } catch {
    return undefined;
  }
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

/** Creates the table on first run so there is no setup step. */
async function ensureTable(): Promise<void> {
  try {
    await client.send(new DescribeTableCommand({ TableName: TABLE_NAME }));
    return;
  } catch (cause) {
    if (!(cause instanceof ResourceNotFoundException)) throw cause;
  }

  await client.send(
    new CreateTableCommand({
      TableName: TABLE_NAME,
      // Mirrors the CDK definition: partition by owner, sort by keyboard.
      AttributeDefinitions: [
        { AttributeName: "pk", AttributeType: "S" },
        { AttributeName: "sk", AttributeType: "S" },
      ],
      KeySchema: [
        { AttributeName: "pk", KeyType: "HASH" },
        { AttributeName: "sk", KeyType: "RANGE" },
      ],
      BillingMode: "PAY_PER_REQUEST",
    }),
  );

  console.log(`  created table ${TABLE_NAME}`);
}

async function main(): Promise<void> {
  try {
    await ensureTable();
  } catch (cause) {
    console.error(
      `\nCould not reach DynamoDB Local at ${ENDPOINT}.\n` +
        `Start it first:\n\n  npm run dev:ddb\n\n` +
        `(${cause instanceof Error ? cause.message : String(cause)})\n`,
    );
    process.exit(1);
  }

  // Imported after the environment is set, so the repository picks it up.
  const { handler } = await import("./handler.js");

  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", `http://localhost:${PORT}`);
      const method = request.method ?? "GET";

      // The client proxies through Vite in development, so this is only for
      // calling the server directly. Permissive because it is localhost only.
      const cors = {
        "Access-Control-Allow-Origin": request.headers.origin ?? "*",
        "Access-Control-Allow-Headers": "authorization,content-type,x-dev-user",
        "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
      };

      if (method === "OPTIONS") {
        response.writeHead(204, cors).end();
        return;
      }

      const sub = resolveSub(request);
      const body = await readBody(request);

      // The shape API Gateway sends, with only the fields the handler reads.
      const event = {
        version: "2.0",
        rawPath: url.pathname,
        rawQueryString: url.search.slice(1),
        headers: request.headers,
        requestContext: {
          http: { method, path: url.pathname },
          ...(sub ? { authorizer: { jwt: { claims: { sub }, scopes: [] } } } : {}),
        },
        ...(body ? { body } : {}),
        isBase64Encoded: false,
      };

      try {
        const result = await handler(event as never);
        const status = result.statusCode ?? 200;

        response.writeHead(status, { ...cors, ...(result.headers as Record<string, string>) });
        response.end(result.body ?? "");

        console.log(`  ${method} ${url.pathname} → ${status}${sub ? ` (${sub})` : ""}`);
      } catch (cause) {
        console.error(`  ${method} ${url.pathname} → 500`, cause);
        response.writeHead(500, { ...cors, "Content-Type": "application/problem+json" });
        response.end(
          JSON.stringify({
            type: "https://www.rfc-editor.org/rfc/rfc9457",
            title: "Internal Server Error",
            status: 500,
            detail: cause instanceof Error ? cause.message : String(cause),
          }),
        );
      }
    })();
  });

  server.listen(PORT, "127.0.0.1", () => {
    console.log(`\n  serverless API  http://localhost:${PORT}`);
    console.log(`  DynamoDB        ${ENDPOINT} (table ${TABLE_NAME})`);
    console.log(`  auth            NOT VERIFIED — decodes the token, or X-Dev-User\n`);
  });
}

void main();
