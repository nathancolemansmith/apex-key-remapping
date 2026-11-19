import type { ValidationError } from "@apex/hid-catalog";
import type { APIGatewayProxyStructuredResultV2 } from "aws-lambda";

/**
 * Responses, shaped to match packages/api-contract/openapi.yaml — and
 * therefore to match what the .NET implementation returns, byte for byte
 * where it matters.
 *
 * The error text itself comes from the shared domain package rather than
 * being written again here, which is the whole reason both backends can
 * promise the same problem details.
 */

const RFC = "https://www.rfc-editor.org/rfc/rfc9457";

export const ok = (body: unknown): APIGatewayProxyStructuredResultV2 => ({
  statusCode: 200,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

/** The brief asks for no body beyond an indication of success. */
export const noContent = (): APIGatewayProxyStructuredResultV2 => ({ statusCode: 204 });

interface ProblemBody {
  type: string;
  title: string;
  status: number;
  detail: string;
  errors?: readonly ValidationError[];
}

const problem = (body: ProblemBody): APIGatewayProxyStructuredResultV2 => ({
  statusCode: body.status,
  headers: { "Content-Type": "application/problem+json" },
  // `errors` is omitted rather than serialized as null when absent. The
  // contract declares it as an array present only on validation failures, and
  // the .NET side had to be fixed for exactly this — a null there would make
  // the two implementations disagree on a shape everything else says is
  // identical.
  body: JSON.stringify(body),
});

export const unauthorized = (): APIGatewayProxyStructuredResultV2 =>
  problem({
    type: RFC,
    title: "Unauthorized",
    status: 401,
    detail: "A valid bearer token is required.",
  });

export const unknownKeyboard = (identifier: string): APIGatewayProxyStructuredResultV2 =>
  problem({
    type: RFC,
    title: "Not Found",
    status: 404,
    detail: `'${identifier}' is not a supported keyboard.`,
  });

export const validationFailed = (
  errors: readonly ValidationError[],
): APIGatewayProxyStructuredResultV2 =>
  problem({
    type: RFC,
    title: "Invalid key mappings",
    status: 400,
    detail: `The request contained ${errors.length} invalid mapping${errors.length === 1 ? "" : "s"}.`,
    errors,
  });

export const malformedBody = (detail: string): APIGatewayProxyStructuredResultV2 =>
  problem({
    type: RFC,
    title: "Invalid key mappings",
    status: 400,
    detail,
    errors: [{ index: -1, field: "mappings", message: detail }],
  });

export const notFound = (): APIGatewayProxyStructuredResultV2 =>
  problem({
    type: RFC,
    title: "Not Found",
    status: 404,
    detail: "No such route.",
  });
