import * as path from "node:path";
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import type * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import type { Construct } from "constructs";

export interface WebStackProps extends StackProps {
  readonly loadBalancer: elbv2.IApplicationLoadBalancer;
}

/**
 * The React client on S3, served through CloudFront — which also fronts the
 * API.
 *
 * One distribution with two origins, rather than a bucket on its own, and the
 * reasons are worth stating because the obvious setup does not work:
 *
 * **Cognito requires HTTPS callbacks.** Only `localhost` may use plain HTTP.
 * S3 website hosting is HTTP-only, so a bucket by itself cannot be the
 * redirect target for a hosted UI login.
 *
 * **Mixed content would block the API calls.** An HTTPS page may not fetch
 * from an HTTP origin, and the ALB has no certificate — it has no domain to
 * get one for. Routing `/api` through the same distribution means the browser
 * sees HTTPS while CloudFront talks HTTP to the ALB inside AWS.
 *
 * **Same origin means no CORS.** The client fetches `/api/...` as a relative
 * path, so there is no cross-origin configuration to get wrong, and no
 * preflight on every request.
 *
 * The bucket itself stays private. CloudFront reads it through an Origin
 * Access Control; nothing is publicly readable from S3 directly.
 */
export class WebStack extends Stack {
  readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: WebStackProps) {
    super(scope, id, props);

    const bucket = new s3.Bucket(this, "Site", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,

      // Assessment deployment: tear down cleanly rather than leaving an
      // orphaned bucket that blocks the next deploy.
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const apiOrigin = new origins.LoadBalancerV2Origin(props.loadBalancer, {
      // The ALB speaks HTTP only. This hop is inside AWS; the browser's
      // connection to CloudFront is HTTPS either way.
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
      readTimeout: Duration.seconds(30),
    });

    const apiBehavior: cloudfront.BehaviorOptions = {
      origin: apiOrigin,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,

      // Never cache the API. Responses are per-user and a cached 200 served
      // to the wrong bearer token would be a data leak, not a stale page.
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,

      // Forward everything except Host. The Authorization header has to reach
      // the API or every request is a 401; keeping the viewer's Host would
      // make the ALB see the CloudFront domain instead of its own.
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
    };

    this.distribution = new cloudfront.Distribution(this, "Cdn", {
      comment: "Apex key remapping — React client and API",
      defaultRootObject: "index.html",

      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        compress: true,
      },

      additionalBehaviors: {
        "/api/*": apiBehavior,
        "/health": apiBehavior,
      },

      // The client is a single-page app: /callback is a route it handles, not
      // an object in the bucket. S3 answers 403 for a missing key behind an
      // access control, so both are mapped back to the app.
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: "/index.html", ttl: Duration.minutes(5) },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: "/index.html", ttl: Duration.minutes(5) },
      ],

      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
    });

    // Uploads apps/web/dist and invalidates the cache, so a deploy is visible
    // immediately rather than after the TTL expires.
    new s3deploy.BucketDeployment(this, "Deploy", {
      sources: [s3deploy.Source.asset(path.join(__dirname, "..", "..", "apps", "web", "dist"))],
      destinationBucket: bucket,
      distribution: this.distribution,
      distributionPaths: ["/*"],
      prune: true,
    });

    new CfnOutput(this, "WebUrl", {
      value: `https://${this.distribution.distributionDomainName}`,
      description: "The client. Add '<this>/callback' to the Cognito app client's callback URLs.",
    });

    new CfnOutput(this, "CallbackUrl", {
      value: `https://${this.distribution.distributionDomainName}/callback`,
      description: "Pass to ApexIdentity as -c webOrigin=... so Cognito will redirect here",
    });

    new CfnOutput(this, "SiteBucket", {
      value: bucket.bucketName,
      description: "Static assets bucket (private; readable only via CloudFront)",
    });
  }
}
