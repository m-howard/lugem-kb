import Link from '@docusaurus/Link';
import useBaseUrl from '@docusaurus/useBaseUrl';
import { type ReactElement } from 'react';

import styles from './styles.module.css';
import { type Citation } from './types';

function SourceLink({ citation }: { readonly citation: Citation }): ReactElement {
  const label = citation.path ?? citation.sourceUri;
  const href = useBaseUrl(citation.url ?? '/');

  // A citation whose URI is not part of this corpus keeps its passage and loses its link. A dead
  // link is worse than plain text — it looks checkable and is not.
  if (citation.url === null) {
    return <span className={styles.sourceLabel}>{label}</span>;
  }
  return <Link to={href}>{label}</Link>;
}

/**
 * The sources an answer drew on, numbered to match its `[n]` markers.
 *
 * Each entry carries the page's `last_reviewed` date, so staleness is as visible here as it is on
 * the page (requirements.md R20). The date is omitted rather than rendered as "unknown" when it
 * could not be read — "Reviewed unknown" reads as an assertion about the page, and it is not one.
 *
 * The verbatim passage sits in a collapsed `details`. It is what makes a citation checkable, so
 * it has to be reachable; it should not crowd out the answer.
 */
export function Citations({
  citations,
}: {
  readonly citations: readonly Citation[];
}): ReactElement {
  return (
    <div className={styles.citations}>
      <p className={styles.citationsHeading}>Sources</p>
      <ol className={styles.citationList}>
        {citations.map((citation, index) => (
          <li key={citation.sourceUri + String(index)} className={styles.citation}>
            <SourceLink citation={citation} />
            {citation.lastReviewed !== null && (
              <span className={styles.reviewed}>Reviewed {citation.lastReviewed}</span>
            )}
            <details className={styles.passage}>
              <summary>Show the passage</summary>
              <p>{citation.text}</p>
            </details>
          </li>
        ))}
      </ol>
    </div>
  );
}
