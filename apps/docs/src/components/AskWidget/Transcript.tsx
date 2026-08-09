import { type ReactElement } from 'react';

import { Citations } from './Citations';
import styles from './styles.module.css';
import { type Turn } from './types';

function AnswerTurn({ turn }: { readonly turn: Extract<Turn, { kind: 'answer' }> }): ReactElement {
  return (
    <div className={styles.answer}>
      {/*
        Plain text, deliberately. Not markdown, and never dangerouslySetInnerHTML: this string is
        model output derived from retrieved documents, which is a direct injection path into a
        docs site. Rendering bold text is not worth owning that surface, and the system prompt
        asks for plain prose to match. `white-space: pre-wrap` keeps the paragraphs.
      */}
      <p className={styles.answerText} aria-live="off">
        {turn.text}
        {turn.status === 'streaming' && <span className={styles.caret} aria-hidden="true" />}
      </p>
      {turn.citations.length > 0 && <Citations citations={turn.citations} />}
    </div>
  );
}

/**
 * The conversation so far.
 *
 * The no-coverage turn is styled as its own thing rather than as an answer with no sources. The
 * API gives that case a distinct response shape so a client cannot render it as an answer; this
 * is the client keeping that bargain.
 */
export function Transcript({ turns }: { readonly turns: readonly Turn[] }): ReactElement {
  return (
    <div className={styles.transcript} role="log">
      {turns.map((turn) => {
        if (turn.kind === 'question') {
          return (
            <p key={turn.id} className={styles.question}>
              {turn.text}
            </p>
          );
        }
        if (turn.kind === 'answer') {
          return <AnswerTurn key={turn.id} turn={turn} />;
        }
        if (turn.kind === 'not-covered') {
          return (
            <p key={turn.id} className={styles.notCovered}>
              {turn.message}
            </p>
          );
        }
        return (
          <p key={turn.id} className={styles.failure}>
            {turn.message}
          </p>
        );
      })}
    </div>
  );
}
