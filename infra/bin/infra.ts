#!/usr/bin/env node
import { App, Tags } from "aws-cdk-lib";
import { DotnetApiStack } from "../lib/dotnet-api-stack.js";
import { GithubDeployStack } from "../lib/github-deploy-stack.js";
import { SharedIdentityStack } from "../lib/shared-identity-stack.js";
import { WebStack } from "../lib/web-stack.js";

const app = new App();

// CDK_DEFAULT_* come from the ambient AWS credentials, so this follows
// whichever profile the operator is using rather than pinning an account into
// source control.
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? "us-east-1",
};

const repository =
  app.node.tryGetContext("repository") ?? "nathancolemansmith/apex-key-remapping";

/**
 * Three stacks, split by how often they change and what it costs to replace
 * them.
 *
 * Identity holds accounts and must outlive any backend. The API stack is the
 * expensive, disposable one — `cdk destroy` it to stop paying for an ALB
 * without losing a single user. The deploy role is bootstrapping: it exists so
 * CI can deploy the others, and CI cannot create it.
 */
const identity = new SharedIdentityStack(app, "ApexIdentity", {
  env,
  description: "Cognito user pool shared by both API implementations and the web client",

  // Supplied on the second pass, once the web stack has a CloudFront domain:
  //   npx cdk deploy ApexIdentity -c webOrigin=https://xxxx.cloudfront.net
  ...(app.node.tryGetContext("webOrigin")
    ? { webOrigin: app.node.tryGetContext("webOrigin") as string }
    : {}),
});

const api = new DotnetApiStack(app, "ApexDotnetApi", {
  env,
  description: "ASP.NET Core API on ECS Fargate, SQLite on EFS, behind an ALB",
  userPool: identity.userPool,
  userPoolClient: identity.apiClient,
});

// Explicit, though CDK would infer it from the cross-stack references: the
// API cannot validate tokens from a pool that does not exist yet.
api.addStackDependency(identity);

const web = new WebStack(app, "ApexWeb", {
  env,
  description: "React client on S3, served with the API through one CloudFront distribution",
  loadBalancer: api.loadBalancer,
});

web.addStackDependency(api);

new GithubDeployStack(app, "ApexGithubDeploy", {
  env,
  description: "OIDC provider and the role GitHub Actions assumes to deploy",
  repository,
  branches: ["main"],

  // The deploy job declares `environment: production`, which makes GitHub
  // issue a token subject naming the environment instead of the branch.
  // Without this the branch rule alone never matches and the assume fails.
  environments: ["production"],

  // This repository has immutable subject claims enabled, so the real subject
  // carries numeric ids rather than the readable name. Verify before changing
  // it — a wrong prefix fails with a message that says nothing about why:
  //
  //   gh api repos/OWNER/NAME/actions/oidc/customization/sub
  //
  // Override via `cdk deploy -c subjectPrefix=...` when deploying from a fork
  // or a repository with different settings.
  subjectPrefix:
    app.node.tryGetContext("subjectPrefix") ??
    "repo:nathancolemansmith@348550787/apex-key-remapping@1463362704",
});

Tags.of(app).add("project", "apex-key-remapping");
Tags.of(app).add("managed-by", "cdk");
