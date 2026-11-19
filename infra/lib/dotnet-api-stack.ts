import * as path from "node:path";
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as efs from "aws-cdk-lib/aws-efs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as logs from "aws-cdk-lib/aws-logs";
import type { Construct } from "constructs";

export interface DotnetApiStackProps extends StackProps {
  readonly userPool: cognito.IUserPool;
  readonly userPoolClient: cognito.IUserPoolClient;
}

/**
 * The .NET API on ECS Fargate, behind an ALB, with its SQLite file on EFS.
 *
 * Three decisions here are worth more than the code that expresses them.
 *
 * **Public subnets, no NAT.** Fargate tasks get public IPs and pull images
 * from ECR directly. A private-subnet layout is the usual production answer,
 * but it needs a NAT Gateway at roughly $32/month — more than everything else
 * in this stack combined, bought to hide a service that is deliberately
 * internet-facing anyway.
 *
 * **EFS, because Fargate's disk is ephemeral.** The brief asks for SQLite that
 * persists between runs. A container filesystem loses that on every redeploy,
 * restart and scale event, so the database lives on a mounted filesystem
 * instead. This is the cost of answering the brief literally in a place that
 * has no local disk.
 *
 * **One task, always.** SQLite permits a single writer. The service is pinned
 * to one task and deployments stop the old one before starting the new one,
 * which trades a few seconds of downtime for never having two processes
 * writing the same file. It is also the honest limit of this design: it does
 * not scale horizontally, and saying so is better than discovering it.
 */
export class DotnetApiStack extends Stack {
  /** Exposed so the web stack can route `/api` to it from CloudFront. */
  readonly loadBalancer: elbv2.IApplicationLoadBalancer;

  constructor(scope: Construct, id: string, props: DotnetApiStackProps) {
    super(scope, id, props);

    const vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        { name: "public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
      ],
    });

    // ── Storage ─────────────────────────────────────────────────────────────

    const fileSystem = new efs.FileSystem(this, "Data", {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
      throughputMode: efs.ThroughputMode.BURSTING,
      encrypted: true,

      // Assessment deployment: destroy with the stack rather than leaving an
      // orphaned filesystem behind. A real service would retain this.
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // 1654 is the `app` user that the dotnet/aspnet base image ships and the
    // container runs as. The access point would override the uid for NFS
    // regardless, but matching it means ownership reads the same inside the
    // container and on the filesystem. Without an access point at all, the
    // mount lands root-owned and the app cannot create its database.
    const accessPoint = fileSystem.addAccessPoint("DataAccessPoint", {
      path: "/apex",
      createAcl: { ownerUid: "1654", ownerGid: "1654", permissions: "750" },
      posixUser: { uid: "1654", gid: "1654" },
    });

    // ── Compute ─────────────────────────────────────────────────────────────

    const cluster = new ecs.Cluster(this, "Cluster", {
      vpc,
      containerInsightsV2: ecs.ContainerInsights.DISABLED,
    });

    const taskDefinition = new ecs.FargateTaskDefinition(this, "TaskDefinition", {
      cpu: 256,
      memoryLimitMiB: 512,
      volumes: [
        {
          name: "data",
          efsVolumeConfiguration: {
            fileSystemId: fileSystem.fileSystemId,
            transitEncryption: "ENABLED",
            authorizationConfig: { accessPointId: accessPoint.accessPointId, iam: "ENABLED" },
          },
        },
      ],
    });

    fileSystem.grantReadWrite(taskDefinition.taskRole);

    const container = taskDefinition.addContainer("Api", {
      // Built from apps/api-dotnet/Dockerfile and pushed to ECR by the CDK.
      // This is why `cdk deploy` needs a running Docker daemon.
      image: ecs.ContainerImage.fromAsset(path.join(__dirname, "..", "..", "apps", "api-dotnet"), {
        platform: require("aws-cdk-lib/aws-ecr-assets").Platform.LINUX_AMD64,
      }),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: "apex-api",
        logRetention: logs.RetentionDays.ONE_WEEK,
      }),
      environment: {
        ASPNETCORE_ENVIRONMENT: "Production",
        ASPNETCORE_HTTP_PORTS: "8080",

        // The database lives on the mount, not in the image.
        ConnectionStrings__Apex: "Data Source=/data/apex.db",

        // What turns on real JWT validation. The issuer's JWKS is discovered
        // from {authority}/.well-known/openid-configuration, so no key
        // material is baked into the image or passed as a secret.
        Auth__Authority: `https://cognito-idp.${this.region}.amazonaws.com/${props.userPool.userPoolId}`,
        Auth__ClientId: props.userPoolClient.userPoolClientId,
      },
      portMappings: [{ containerPort: 8080 }],

      // Fail fast if the app cannot start — otherwise a broken image sits in
      // a crash loop while the ALB reports a healthy-but-empty target group.
      healthCheck: {
        command: ["CMD-SHELL", "curl -fsS http://localhost:8080/health || exit 1"],
        interval: Duration.seconds(30),
        timeout: Duration.seconds(5),
        retries: 3,
        startPeriod: Duration.seconds(60),
      },
    });

    container.addMountPoints({
      containerPath: "/data",
      sourceVolume: "data",
      readOnly: false,
    });

    const service = new ecs.FargateService(this, "Service", {
      cluster,
      taskDefinition,
      desiredCount: 1,

      // Tasks need public IPs because there is no NAT to reach ECR through.
      assignPublicIp: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },

      // Stop the old task before starting the new one. The default rolling
      // update would briefly run two tasks against one SQLite file.
      minHealthyPercent: 0,
      maxHealthyPercent: 100,

      circuitBreaker: { rollback: true },
      enableExecuteCommand: true,
    });

    service.connections.allowToDefaultPort(fileSystem, "NFS to the SQLite volume");

    // ── Ingress ─────────────────────────────────────────────────────────────

    const loadBalancer = new elbv2.ApplicationLoadBalancer(this, "Alb", {
      vpc,
      internetFacing: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });
    this.loadBalancer = loadBalancer;

    const listener = loadBalancer.addListener("Http", {
      port: 80,
      open: true,
    });

    listener.addTargets("Api", {
      port: 8080,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [service],
      healthCheck: {
        path: "/health",
        interval: Duration.seconds(30),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
      // Nothing is cached per-user and there is one task anyway; draining
      // fast keeps redeploys short.
      deregistrationDelay: Duration.seconds(10),
    });

    new CfnOutput(this, "ApiUrl", {
      value: `http://${loadBalancer.loadBalancerDnsName}`,
      description: "Base URL — set this as {{baseUrl}} in the Postman environment",
    });

    new CfnOutput(this, "LogGroup", {
      value: `/aws/ecs/${this.stackName}`,
      description: "Where container logs land (stream prefix: apex-api)",
    });
  }
}
