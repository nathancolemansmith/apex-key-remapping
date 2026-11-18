import { CfnOutput, Stack, type StackProps } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import type { Construct } from "constructs";

export interface GithubDeployStackProps extends StackProps {
  /** `owner/repo`, e.g. `nathancolemansmith/apex-key-remapping`. */
  readonly repository: string;
  /** Branches allowed to assume the role. Defaults to `main` only. */
  readonly branches?: string[];
}

/**
 * The role GitHub Actions assumes to deploy, and the trust that makes it
 * possible without storing an AWS key anywhere.
 *
 * GitHub signs a short-lived OIDC token for each workflow run describing which
 * repository, branch and workflow is running. AWS is configured to trust that
 * issuer, and the role's trust policy narrows it further to this repository
 * and these branches. The practical effect: there is no secret to leak, no key
 * to rotate, and a fork or a pull request from one cannot assume the role —
 * the `sub` claim would not match.
 *
 * This stack is deployed once, by hand, from an authenticated machine. The
 * pipeline cannot create the thing that grants the pipeline access.
 */
export class GithubDeployStack extends Stack {
  constructor(scope: Construct, id: string, props: GithubDeployStackProps) {
    super(scope, id, props);

    const branches = props.branches ?? ["main"];

    const provider = new iam.OpenIdConnectProvider(this, "GithubOidc", {
      url: "https://token.actions.githubusercontent.com",
      clientIds: ["sts.amazonaws.com"],
    });

    const role = new iam.Role(this, "DeployRole", {
      roleName: "apex-key-remapping-github-deploy",
      description: "Assumed by GitHub Actions to deploy the Apex key remapping stacks",
      maxSessionDuration: Stack.of(this).node.tryGetContext("maxSessionDuration") ?? undefined,

      assumedBy: new iam.WebIdentityPrincipal(provider.openIdConnectProviderArn, {
        StringEquals: {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
        },
        // Only these branches of this repository. A pull request from a fork
        // produces `repo:owner/repo:pull_request`, which matches none of these.
        StringLike: {
          "token.actions.githubusercontent.com:sub": branches.map(
            (branch) => `repo:${props.repository}:ref:refs/heads/${branch}`,
          ),
        },
      }),
    });

    // The CDK deploys by assuming its own bootstrap roles, so what this role
    // actually needs is permission to assume those. That keeps the blast
    // radius tied to what `cdk bootstrap` provisioned rather than handing the
    // pipeline broad account access.
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "AssumeCdkBootstrapRoles",
        actions: ["sts:AssumeRole"],
        resources: [
          `arn:aws:iam::${this.account}:role/cdk-*-deploy-role-${this.account}-${this.region}`,
          `arn:aws:iam::${this.account}:role/cdk-*-file-publishing-role-${this.account}-${this.region}`,
          `arn:aws:iam::${this.account}:role/cdk-*-image-publishing-role-${this.account}-${this.region}`,
          `arn:aws:iam::${this.account}:role/cdk-*-lookup-role-${this.account}-${this.region}`,
        ],
      }),
    );

    // `cdk deploy` reads stack state before it can decide what to change.
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "ReadCloudFormationState",
        actions: [
          "cloudformation:DescribeStacks",
          "cloudformation:DescribeStackEvents",
          "cloudformation:GetTemplate",
          "cloudformation:ListStacks",
        ],
        resources: ["*"],
      }),
    );

    new CfnOutput(this, "DeployRoleArn", {
      value: role.roleArn,
      description: "Set as AWS_DEPLOY_ROLE_ARN in the repository's Actions variables",
    });

    new CfnOutput(this, "TrustedSubjects", {
      value: branches.map((b) => `repo:${props.repository}:ref:refs/heads/${b}`).join(", "),
      description: "The only OIDC subjects allowed to assume the role",
    });
  }
}
