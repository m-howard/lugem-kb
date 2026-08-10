import { describe, expect, it } from 'vitest';

import { StackConfigError } from './config';
import { DEFAULT_REQUIRED_STATUS_CHECKS, validateGithubConfig } from './github-config';

const VALID = {
  corpusRepository: 'm-howard/lugem-kb',
} as const;

const CMS_APP = {
  cmsGitHubAppId: '123456',
  cmsGitHubAppInstallationId: '78901234',
} as const;

const ISSUER = 'https://idp.example.com/realm';
const AUDIENCE = 'lugem-cms';
const CERTIFICATE_ARN = 'arn:aws:acm:us-east-1:111122223333:certificate/abc-123';

function expectKeys(input: Parameters<typeof validateGithubConfig>[0], ...keys: string[]): void {
  expect(() => validateGithubConfig(input)).toThrow(StackConfigError);
  try {
    validateGithubConfig(input);
    expect.unreachable('validateGithubConfig should have thrown');
  } catch (error) {
    for (const key of keys) {
      expect((error as StackConfigError).keys).toContain(key);
    }
  }
}

describe('validateGithubConfig', () => {
  // The GitHub half needs an admin token the AWS half does not, so a stack that manages no GitHub
  // resources is a supported configuration rather than a half-configured one.
  describe('the master switch', () => {
    it.each([
      ['absent', undefined],
      ['blank', '   '],
    ])('returns undefined when corpusRepository is %s', (_case, corpusRepository) => {
      expect(validateGithubConfig({ corpusRepository })).toBeUndefined();
    });

    it('accepts a minimal configuration and applies defaults', () => {
      const config = validateGithubConfig({ ...VALID });

      expect(config).toMatchObject({
        owner: 'm-howard',
        repository: 'lugem-kb',
        fullName: 'm-howard/lugem-kb',
        defaultBranch: 'main',
        description: undefined,
        createRepository: false,
        importId: undefined,
        manageRepositoryResource: false,
        requiredStatusChecks: DEFAULT_REQUIRED_STATUS_CHECKS,
        oidcProviderArn: undefined,
        cmsApp: undefined,
      });
    });
  });

  describe('corpusRepository', () => {
    it.each([
      ['a bare name', 'lugem-kb'],
      ['a full URL', 'https://github.com/m-howard/lugem-kb'],
      ['a trailing segment', 'm-howard/lugem-kb/docs'],
      ['an empty owner', '/lugem-kb'],
      ['an empty name', 'm-howard/'],
      ['an owner with a space', 'm howard/lugem-kb'],
    ])('rejects %s', (_case, corpusRepository) => {
      expectKeys({ corpusRepository }, 'corpusRepository');
    });

    it.each([
      ['dots', 'acme/docs.corpus'],
      ['underscores', 'acme/docs_corpus'],
      ['digits', 'acme2/corpus9'],
    ])('accepts a repository name containing %s', (_case, corpusRepository) => {
      expect(validateGithubConfig({ corpusRepository })?.fullName).toBe(corpusRepository);
    });

    it('trims surrounding whitespace rather than failing on it', () => {
      expect(validateGithubConfig({ corpusRepository: '  acme/corpus  ' })?.owner).toBe('acme');
    });
  });

  // GitHub clears a description the repository resource does not declare, so an operator adopting
  // an existing repository needs somewhere to restate the one already there.
  describe('corpusRepositoryDescription', () => {
    it('passes a description through', () => {
      const config = validateGithubConfig({
        ...VALID,
        corpusRepositoryDescription: 'The documentation corpus.',
      });
      expect(config?.description).toBe('The documentation corpus.');
    });

    it('treats a blank description as absent', () => {
      expect(
        validateGithubConfig({ ...VALID, corpusRepositoryDescription: '  ' })?.description,
      ).toBeUndefined();
    });
  });

  // Creating and adopting are different first runs. Silently preferring one would either try to
  // create a repository that exists or adopt one that does not.
  describe('create versus adopt', () => {
    it('reports the repository as managed when it is created', () => {
      const config = validateGithubConfig({ ...VALID, corpusRepositoryCreate: true });
      expect(config).toMatchObject({ createRepository: true, manageRepositoryResource: true });
    });

    it('reports the repository as managed when it is adopted', () => {
      const config = validateGithubConfig({ ...VALID, corpusRepositoryImportId: 'lugem-kb' });
      expect(config).toMatchObject({ importId: 'lugem-kb', manageRepositoryResource: true });
    });

    it('names both keys when asked to create and adopt at once', () => {
      expectKeys(
        { ...VALID, corpusRepositoryCreate: true, corpusRepositoryImportId: 'lugem-kb' },
        'corpusRepositoryCreate',
        'corpusRepositoryImportId',
      );
    });
  });

  describe('corpusDefaultBranch', () => {
    it('accepts a plain branch name', () => {
      expect(validateGithubConfig({ ...VALID, corpusDefaultBranch: 'trunk' })?.defaultBranch).toBe(
        'trunk',
      );
    });

    // The ruleset condition and the OIDC subject both want a branch name; a fully qualified ref
    // would match nothing and protect nothing.
    it('rejects a fully qualified ref', () => {
      expectKeys({ ...VALID, corpusDefaultBranch: 'refs/heads/main' }, 'corpusDefaultBranch');
    });
  });

  describe('requiredStatusChecks', () => {
    it('defaults to the checks that run on every pull request', () => {
      expect(validateGithubConfig({ ...VALID })?.requiredStatusChecks).toEqual([
        'Lint',
        'Typecheck',
        'Test',
        'Build',
        'Playwright',
      ]);
    });

    it('honours an explicitly empty list as "protect the branch, require no checks"', () => {
      expect(
        validateGithubConfig({ ...VALID, requiredStatusChecks: [] })?.requiredStatusChecks,
      ).toEqual([]);
    });

    it('trims each entry', () => {
      expect(
        validateGithubConfig({ ...VALID, requiredStatusChecks: [' Lint ', 'Test'] })
          ?.requiredStatusChecks,
      ).toEqual(['Lint', 'Test']);
    });

    it('rejects a blank entry, which would require a check no job reports', () => {
      expectKeys({ ...VALID, requiredStatusChecks: ['Lint', '  '] }, 'requiredStatusChecks');
    });
  });

  describe('githubOidcProviderArn', () => {
    it('accepts an IAM OIDC provider ARN', () => {
      const arn = 'arn:aws:iam::111122223333:oidc-provider/token.actions.githubusercontent.com';
      expect(validateGithubConfig({ ...VALID, githubOidcProviderArn: arn })?.oidcProviderArn).toBe(
        arn,
      );
    });

    // Pasting the deploy role ARN here is the obvious slip, and it fails at assume-role time
    // rather than at preview time unless it is caught here.
    it.each([
      ['a role ARN', 'arn:aws:iam::111122223333:role/github-actions'],
      ['a bare provider URL', 'token.actions.githubusercontent.com'],
    ])('rejects %s', (_case, githubOidcProviderArn) => {
      expectKeys({ ...VALID, githubOidcProviderArn }, 'githubOidcProviderArn');
    });
  });

  // R2: the gateway mints installation tokens. One id without the other cannot mint anything, so
  // a half-configured app is refused rather than deployed into a service that will fail readiness.
  describe('the CMS GitHub App', () => {
    it('accepts both ids together', () => {
      const config = validateGithubConfig({
        ...VALID,
        ...CMS_APP,
        cmsAuthMode: 'bearer',
        cmsAuthIssuerUrl: ISSUER,
        cmsAuthAudience: AUDIENCE,
      });
      expect(config?.cmsApp).toEqual({ appId: '123456', installationId: '78901234' });
    });

    it.each([
      ['only the app id', { cmsGitHubAppId: '123456' }],
      ['only the installation id', { cmsGitHubAppInstallationId: '78901234' }],
    ])('names both keys when given %s', (_case, override) => {
      expectKeys({ ...VALID, ...override }, 'cmsGitHubAppId', 'cmsGitHubAppInstallationId');
    });

    it.each([
      ['the app slug', { cmsGitHubAppId: 'lugem-docs-cms', cmsGitHubAppInstallationId: '789' }],
      [
        'a non-numeric installation id',
        { cmsGitHubAppId: '123', cmsGitHubAppInstallationId: 'i7' },
      ],
    ])('rejects %s', (_case, override) => {
      expect(() => validateGithubConfig({ ...VALID, ...override })).toThrow(StackConfigError);
    });
  });

  // R1, and ADR 0013. The gateway supports two ways of establishing identity because
  // requirements.md Q3 — which identity provider fronts this — is still open. What it does not do
  // is guess: with the App configured and no mode chosen, the preview fails.
  describe('the CMS gateway', () => {
    const BEARER = {
      ...CMS_APP,
      cmsAuthMode: 'bearer',
      cmsAuthIssuerUrl: ISSUER,
      cmsAuthAudience: AUDIENCE,
    };

    const ALB = {
      ...CMS_APP,
      cmsAuthMode: 'alb',
      certificateArn: CERTIFICATE_ARN,
      cmsOidcIssuer: ISSUER,
      cmsOidcAuthorizationEndpoint: `${ISSUER}/authorize`,
      cmsOidcTokenEndpoint: `${ISSUER}/token`,
      cmsOidcUserInfoEndpoint: `${ISSUER}/userinfo`,
      cmsOidcClientId: 'lugem-cms',
    };

    it('is absent when no CMS app is configured', () => {
      expect(validateGithubConfig(VALID)?.cmsGateway).toBeUndefined();
    });

    it('applies defaults for everything that is only tuning', () => {
      expect(validateGithubConfig({ ...VALID, ...BEARER })?.cmsGateway).toMatchObject({
        authMode: 'bearer',
        issuerUrl: ISSUER,
        audience: AUDIENCE,
        branchPrefix: 'cms/',
        pathPrefixes: ['docs/'],
        allowMerge: false,
        oidcListener: undefined,
      });
    });

    it('carries the OIDC endpoints in alb mode', () => {
      expect(validateGithubConfig({ ...VALID, ...ALB })?.cmsGateway).toMatchObject({
        authMode: 'alb',
        oidcListener: { issuer: ISSUER, clientId: 'lugem-cms' },
      });
    });

    it('takes overrides for the prefixes and the merge policy', () => {
      const config = validateGithubConfig({
        ...VALID,
        ...BEARER,
        cmsBranchPrefix: 'drafts/',
        cmsPathPrefixes: ['docs/', ' handbook/ '],
        cmsAllowMerge: true,
      });

      expect(config?.cmsGateway).toMatchObject({
        branchPrefix: 'drafts/',
        pathPrefixes: ['docs/', 'handbook/'],
        allowMerge: true,
      });
    });

    describe('fails closed', () => {
      it('refuses an app with no auth mode chosen', () => {
        expectKeys({ ...VALID, ...CMS_APP }, 'cmsAuthMode');
      });

      it('refuses an auth mode it does not implement', () => {
        expectKeys({ ...VALID, ...CMS_APP, cmsAuthMode: 'basic' }, 'cmsAuthMode');
      });

      it('names both bearer keys when neither is set', () => {
        expectKeys(
          { ...VALID, ...CMS_APP, cmsAuthMode: 'bearer' },
          'cmsAuthIssuerUrl',
          'cmsAuthAudience',
        );
      });

      // ALB authentication is an HTTPS listener action. Without a certificate the stack would
      // deploy an ALB that cannot authenticate anyone, and every author would be refused.
      it('refuses alb mode without a certificate', () => {
        const { certificateArn: _certificate, ...withoutCertificate } = ALB;

        expectKeys({ ...VALID, ...withoutCertificate }, 'cmsAuthMode', 'certificateArn');
      });

      it('names every missing OIDC endpoint at once', () => {
        expectKeys(
          { ...VALID, ...CMS_APP, cmsAuthMode: 'alb', certificateArn: CERTIFICATE_ARN },
          'cmsOidcIssuer',
          'cmsOidcAuthorizationEndpoint',
          'cmsOidcTokenEndpoint',
          'cmsOidcUserInfoEndpoint',
          'cmsOidcClientId',
        );
      });

      // In the gateway an empty prefix matches every path, so a stray comma here is the
      // difference between the docs tree and the whole repository.
      it.each([[[]], [['docs/', '']], [[' ']]])(
        'refuses path prefixes %j',
        (cmsPathPrefixes: string[]) => {
          expectKeys({ ...VALID, ...BEARER, cmsPathPrefixes }, 'cmsPathPrefixes');
        },
      );
    });
  });

  // R22 / ADR 0016. Reader authentication borrows the editorial identity provider, so requiring
  // it without one would deploy an ALB rule pointing at nothing — and that fails at apply, long
  // after preview said the stack was fine.
  describe('reader authentication', () => {
    it('is allowed alongside a configured CMS', () => {
      const config = validateGithubConfig({
        ...VALID,
        ...CMS_APP,
        cmsAuthMode: 'bearer',
        cmsAuthIssuerUrl: ISSUER,
        cmsAuthAudience: AUDIENCE,
        readerAuthRequired: true,
      });

      expect(config?.cmsGateway?.authMode).toBe('bearer');
    });

    it('is refused on a stack with no CMS configured', () => {
      expectKeys({ ...VALID, readerAuthRequired: true }, 'readerAuthRequired');
    });

    it('is not required by default, so no stack is broken by its existence', () => {
      expect(validateGithubConfig({ ...VALID })).toMatchObject({ fullName: 'm-howard/lugem-kb' });
    });
  });
});
