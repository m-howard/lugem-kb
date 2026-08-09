import * as aws from '@pulumi/aws';
import * as github from '@pulumi/github';
import * as pulumi from '@pulumi/pulumi';

import { type CmsAppConfig } from '../github-config';

/** Long enough to undo a mistaken destroy, short enough that a rotated key does not linger. */
const SECRET_RECOVERY_WINDOW_DAYS = 7;

export interface CmsCredentialArgs {
  readonly app: CmsAppConfig;
  readonly repositoryName: pulumi.Input<string>;
}

/**
 * Where the gateway's single GitHub App credential lives, and which repository it may act on.
 *
 * requirements.md R2 says the private key is supplied from a secret store and never baked into the
 * image. This creates the store and leaves it **empty** — the PEM is written out of band with
 * `aws secretsmanager put-secret-value`, so it never passes through Pulumi configuration, a state
 * file, or a CI log.
 *
 * Until it is written, the gateway's readiness probe fails because no installation token can be
 * minted. That is R10 working, not a gap: a miscredentialed task never joins the target group.
 *
 * Pulumi cannot create a GitHub App, so the app itself is a documented manual step; what is
 * codified here is which repository its installation reaches.
 *
 * @example
 * ```ts
 * const cms = new CmsCredential('lugem-kb-dev', { app, repositoryName: repo.name });
 * ```
 */
export class CmsCredential extends pulumi.ComponentResource {
  public readonly secretArn: pulumi.Output<string>;
  public readonly secretName: pulumi.Output<string>;

  constructor(name: string, args: CmsCredentialArgs, opts?: pulumi.ComponentResourceOptions) {
    super('lugem:github:CmsCredential', name, {}, opts);

    const secret = new aws.secretsmanager.Secret(
      `${name}-cms-app-key`,
      {
        description: 'PEM private key for the documentation CMS GitHub App (written out of band)',
        recoveryWindowInDays: SECRET_RECOVERY_WINDOW_DAYS,
      },
      { parent: this },
    );

    new github.AppInstallationRepository(
      `${name}-cms-app-installation`,
      { installationId: args.app.installationId, repository: args.repositoryName },
      { parent: this },
    );

    this.secretArn = secret.arn;
    this.secretName = secret.name;

    this.registerOutputs({ secretArn: this.secretArn, secretName: this.secretName });
  }
}
