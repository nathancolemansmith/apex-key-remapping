import { CfnOutput, Stack, type StackProps } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import type { Construct } from "constructs";

export interface GithubDeployStackProps extends StackProps {
  /** `owner/repo`, e.g. `nathancolemansmith/apex-key-remapping`. */
  readonly repository: string;
  /** Branches allowed to assume the role. Defaults to `main` only. */
  readonly branches?: string[];
  /**
   * GitHub environments allowed to assume the role.
   *
   * This is easy to miss and fails confusingly. A job that declares
   * `environment: production` gets an OIDC token whose subject is
   * `repo:owner/repo:environment:production` — the branch is *not* in the
   * claim at all. Trusting only branch subjects means such a job is denied
   * with "Not authorized to perform sts:AssumeRoleWithWebIdentity", which
   * reads like a permissions problem rather than a claim mismatch.
   *
   * Environment subjects are still narrow: the environment is a repository
   * setting, so a fork or an arbitrary branch cannot name one it was not
   * granted.
   */
  readonly environments?: string[];
  /**
   * The subject prefix GitHub actually puts in the token, if it is not the
   * plain `repo:owner/name`.
   *
   * Repositories with **immutable subject claims** enabled get numeric ids
   * appended to both the owner and the repository:
   *
   * ```
   * repo:owner@348550787/name@1463362704:environment:production
   * ```
   *
   * That is rename-proof — renaming a repository cannot silently hand its
   * trust to whoever claims the old name — but it means a trust policy
   * written against the readable name never matches, and the only symptom is
   * a flat "Not authorized to perform sts:AssumeRoleWithWebIdentity".
   *
   * Read the real value rather than guessing it:
   *
   * ```bash
   * gh api repos/OWNER/NAME/actions/oidc/customization/sub
   * ```
   */
  readonly subjectPrefix?: string;
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
    const environments = props.environments ?? [];
    const prefix = props.subjectPrefix ?? `repo:${props.repository}`;

    const subjects = [
      ...branches.map((branch) => `${prefix}:ref:refs/heads/${branch}`),
      ...environments.map((environment) => `${prefix}:environment:${environment}`),
    ];

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
        // Only these subjects, from this repository. A pull request from a
        // fork produces `repo:owner/repo:pull_request`, which matches none of
        // them.
        StringLike: {
          "token.actions.githubusercontent.com:sub": subjects,
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
      value: subjects.join(", "),
      description: "The only OIDC subjects allowed to assume the role",
    });
  }
}
