import * as path from "node:path";
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as apigw from "aws-cdk-lib/aws-apigatewayv2";
import * as authorizers from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import * as integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import type * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import type { Construct } from "constructs";

export interface ServerlessApiStackProps extends StackProps {
  readonly userPool: cognito.IUserPool;
  readonly userPoolClient: cognito.IUserPoolClient;
}

/**
 * The same API again, under different constraints.
 *
 * Every difference from the .NET stack is a consequence of one thing: there
 * is no machine here that stays running.
 *
 * **DynamoDB instead of SQLite.** A Lambda's filesystem is ephemeral and
 * concurrent invocations do not share one, so a SQLite file has nowhere to
 * live. EFS would work, as it does for Fargate, but it would mean a VPC, cold
 * starts behind an ENI, and a single-writer constraint on a runtime whose
 * whole point is scaling out.
 *
 * **Authentication at the edge, not in process.** The .NET app validates
 * tokens itself with JWKS it fetches and caches. Here an API Gateway
 * authorizer does it before Lambda is invoked, so bad tokens never reach
 * application code and never cost an invocation. Less code, and it fails
 * cheaper — at the price of being untestable without AWS, which the .NET
 * version is not.
 *
 * **No VPC, no load balancer, no always-on cost.** This stack bills per
 * request; the Fargate stack bills per hour whether anyone calls it.
 */
export class ServerlessApiStack extends Stack {
  constructor(scope: Construct, id: string, props: ServerlessApiStackProps) {
    super(scope, id, props);

    const table = new dynamodb.TableV2(this, "Layouts", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },

      // Per-request pricing. The alternative is provisioning throughput for a
      // service whose traffic is unknown and mostly zero.
      billing: dynamodb.Billing.onDemand(),

      // Assessment deployment: destroy with the stack rather than orphaning a
      // table. A real service would retain this and enable PITR.
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const api = new nodejs.NodejsFunction(this, "Api", {
      entry: path.join(__dirname, "..", "..", "apps", "api-serverless", "src", "handler.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: Duration.seconds(10),
      logRetention: logs.RetentionDays.ONE_WEEK,

      environment: {
        TABLE_NAME: table.tableName,
        // Trims the cold start: the SDK skips looking for credentials and
        // config files that do not exist in a Lambda sandbox.
        AWS_NODEJS_CONNECTION_REUSE_ENABLED: "1",
      },

      bundling: {
        format: nodejs.OutputFormat.ESM,
        target: "node22",
        minify: true,
        sourceMap: true,

        // The v3 SDK is in the runtime image, so bundling it would add
        // megabytes to the artifact for no benefit.
        externalModules: ["@aws-sdk/*"],
      },
    });

    table.grantReadWriteData(api);

    // Verifies the token against the pool before Lambda is invoked. This is
    // the "trust established at the edge" half of the contrast with the .NET
    // implementation, which does the same work in middleware.
    const authorizer = new authorizers.HttpUserPoolAuthorizer("CognitoAuthorizer", props.userPool, {
      userPoolClients: [props.userPoolClient],
      identitySource: ["$request.header.Authorization"],
    });

    const httpApi = new apigw.HttpApi(this, "HttpApi", {
      description: "Apex key remapping — serverless implementation",
      defaultAuthorizer: authorizer,

      // The client is served from a different origin than this API, unlike
      // the .NET deployment where CloudFront puts them on one. So CORS is
      // required here and is not there — another consequence of the shape.
      corsPreflight: {
        allowOrigins: ["https://d3isop0e6bhby8.cloudfront.net", "http://localhost:5173"],
        allowMethods: [
          apigw.CorsHttpMethod.GET,
          apigw.CorsHttpMethod.POST,
          apigw.CorsHttpMethod.PUT,
          apigw.CorsHttpMethod.DELETE,
          apigw.CorsHttpMethod.OPTIONS,
        ],
        allowHeaders: ["authorization", "content-type"],
        maxAge: Duration.hours(1),
      },
    });

    const integration = new integrations.HttpLambdaIntegration("ApiIntegration", api);

    // Routes are declared rather than inferred, so the authorizer attaches to
    // exactly the ones that need it and /health stays reachable without a
    // token for probes.
    httpApi.addRoutes({
      path: "/health",
      methods: [apigw.HttpMethod.GET],
      integration,
      authorizer: new apigw.HttpNoneAuthorizer(),
    });

    httpApi.addRoutes({
      path: "/api/keyboards",
      methods: [apigw.HttpMethod.GET],
      integration,
    });

    httpApi.addRoutes({
      path: "/api/keyboards/{keyboard}/mappings",
      methods: [
        apigw.HttpMethod.GET,
        apigw.HttpMethod.POST,
        apigw.HttpMethod.PUT,
        apigw.HttpMethod.DELETE,
      ],
      integration,
    });

    httpApi.addRoutes({
      path: "/api/keyboards/{keyboard}/mappings/{hidCode}",
      methods: [apigw.HttpMethod.DELETE],
      integration,
    });

    new CfnOutput(this, "ApiUrl", {
      value: httpApi.apiEndpoint,
      description: "Base URL — point the Postman environment's {{baseUrl}} here",
    });

    new CfnOutput(this, "TableName", {
      value: table.tableName,
      description: "One item per user per keyboard; partition key derived from the token's sub",
    });
  }
}
