import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { DeploymentGuideLink, DEPLOYMENT_GUIDE_URL } from './DeploymentGuideLink';

describe('DeploymentGuideLink', () => {
  it('leads outside the app to the versioned DAB lifecycle without sending a referrer', () => {
    const markup = renderToStaticMarkup(<DeploymentGuideLink />);

    expect(markup).toContain(`href="${DEPLOYMENT_GUIDE_URL}"`);
    expect(markup).toContain('target="_blank"');
    expect(markup).toContain('rel="noreferrer"');
    expect(markup).toContain('Deployment guide');
  });
});
