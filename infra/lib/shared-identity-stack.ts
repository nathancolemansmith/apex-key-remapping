import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import type { Construct } from "constructs";

/**
 * Identity, shared by everything that will ever answer this API.
 *
 * This is its own stack on purpose. The user pool outlives any particular
 * backend: tearing down the .NET service to stop paying for an ALB must not
 * destroy the accounts, and the serverless implementation will point at this
 * same pool rather than standing up a second one. Separate lifecycles belong
 * in separate stacks.
 */
export class SharedIdentityStack extends Stack {
  readonly userPool: cognito.UserPool;
  readonly apiClient: cognito.UserPoolClient;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    this.userPool = new cognito.UserPool(this, "UserPool", {
      userPoolName: "apex-key-remapping",
      selfSignUpEnabled: true,
      signInAliases: { email: true, username: true },
      autoVerify: { email: true },
      standardAttributes: {
        email: { required: true, mutable: true },
      },
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,

      // This is an assessment deployment that is meant to be torn down and
      // stood back up. A retained pool would orphan itself on the next
      // `cdk destroy` and then collide on the next deploy.
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.apiClient = this.userPool.addClient("ApiClient", {
      userPoolClientName: "apex-api",

      // No secret: this client is for a browser SPA and for local tooling,
      // neither of which can keep one. Machine-to-machine access would be a
      // separate client with a secret and a resource server.
      generateSecret: false,

      authFlows: {
        // Lets curl, Postman and the integration tests mint a real token
        // without a browser. The React client will use the hosted UI instead.
        userPassword: true,
        userSrp: true,
      },

      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: ["http://localhost:5173/callback", "http://localhost:3000/callback"],
        logoutUrls: ["http://localhost:5173", "http://localhost:3000"],
      },

      accessTokenValidity: Duration.hours(1),
      idTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(30),

      preventUserExistenceErrors: true,
    });

    // A hosted UI domain, so the React client in step 6 has somewhere to send
    // people without building a login form. Harmless and free until used.
    const domain = this.userPool.addDomain("HostedUi", {
      cognitoDomain: { domainPrefix: `apex-key-remapping-${this.account.slice(-6)}` },
    });

    new CfnOutput(this, "UserPoolId", {
      value: this.userPool.userPoolId,
      description: "Cognito user pool id",
      exportName: "ApexUserPoolId",
    });

    new CfnOutput(this, "UserPoolClientId", {
      value: this.apiClient.userPoolClientId,
      description: "App client id — the `client_id` claim on access tokens",
      exportName: "ApexUserPoolClientId",
    });

    // What the APIs actually need: the issuer they validate tokens against.
    // Its JWKS lives at {issuer}/.well-known/jwks.json, which JwtBearer
    // discovers on its own.
    new CfnOutput(this, "Issuer", {
      value: `https://cognito-idp.${this.region}.amazonaws.com/${this.userPool.userPoolId}`,
      description: "Token issuer — Auth__Authority for the .NET API",
      exportName: "ApexIssuer",
    });

    new CfnOutput(this, "HostedUiDomain", {
      value: domain.baseUrl(),
      description: "Hosted UI base URL, for the React client",
    });
  }
}
