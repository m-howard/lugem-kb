import { type Citation, type ConversationMessage } from './types';

const ASK_ENDPOINT = '/v1/ask';
const FRAME_SEPARATOR = '\n\n';
const TOO_MANY_REQUESTS = 429;

export interface AskHandlers {
  readonly onCitations: (citations: readonly Citation[]) => void;
  readonly onToken: (text: string) => void;
  readonly onNotCovered: (message: string) => void;
  readonly onFailure: (message: string) => void;
}

export interface AskOptions {
  readonly question: string;
  readonly history: readonly ConversationMessage[];
  readonly signal: AbortSignal;
  readonly handlers: AskHandlers;
}

const RATE_LIMITED_MESSAGE = 'Too many questions in a short time. Wait a moment and try again.';
const GENERIC_FAILURE_MESSAGE = 'Something went wrong reaching the documentation assistant.';

function dispatchFrame(frame: string, handlers: AskHandlers): void {
  const lines = frame.split('\n');
  const event = lines
    .find((line) => line.startsWith('event:'))
    ?.slice('event:'.length)
    .trim();
  const raw = lines
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim())
    .join('');

  if (event === undefined || raw === '') {
    return;
  }

  const data: unknown = JSON.parse(raw);
  if (event === 'citations') {
    handlers.onCitations(data as Citation[]);
  } else if (event === 'token') {
    handlers.onToken((data as { text: string }).text);
  } else if (event === 'error') {
    handlers.onFailure(GENERIC_FAILURE_MESSAGE);
  }
}

/**
 * Reads the SSE body frame by frame.
 *
 * The buffer has to survive across reads. A network chunk boundary falls wherever it falls, so a
 * single `data:` line routinely arrives in two pieces — parsing each chunk independently drops
 * text silently, and only under load, which is the worst way to find out.
 */
async function readFrames(body: ReadableStream<Uint8Array>, handlers: AskHandlers): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });

    let boundary = buffer.indexOf(FRAME_SEPARATOR);
    while (boundary !== -1) {
      dispatchFrame(buffer.slice(0, boundary), handlers);
      buffer = buffer.slice(boundary + FRAME_SEPARATOR.length);
      boundary = buffer.indexOf(FRAME_SEPARATOR);
    }
  }
}

/**
 * Asks the documentation a question and streams the answer back through handlers.
 *
 * POST, not `EventSource`: the latter is GET-only, and a question must not travel in a URL where
 * it would land in access logs. The gateway refuses GET on this path for the same reason.
 *
 * The endpoint is a relative path. The gateway serves this site, so the API is always same-origin
 * in production — there is no base URL to configure and no CORS to arrange.
 *
 * Two response shapes are expected, and they are distinguished by content type rather than by
 * guessing: `application/json` means nothing in the corpus covered the question, and no answer is
 * coming; `text/event-stream` means one is.
 *
 * @param options - The question, prior turns, an abort signal, and the handlers to drive.
 */
export async function askTheDocs(options: AskOptions): Promise<void> {
  let response: Response;

  try {
    response = await fetch(ASK_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: options.question, history: options.history }),
      signal: options.signal,
    });
  } catch (error) {
    if (!options.signal.aborted) {
      options.handlers.onFailure(GENERIC_FAILURE_MESSAGE);
    }
    void error;
    return;
  }

  if (!response.ok) {
    options.handlers.onFailure(
      response.status === TOO_MANY_REQUESTS ? RATE_LIMITED_MESSAGE : GENERIC_FAILURE_MESSAGE,
    );
    return;
  }

  if ((response.headers.get('content-type') ?? '').includes('application/json')) {
    const body = (await response.json()) as { message?: string };
    options.handlers.onNotCovered(body.message ?? 'No documentation covers this question.');
    return;
  }

  if (response.body === null) {
    options.handlers.onFailure(GENERIC_FAILURE_MESSAGE);
    return;
  }

  try {
    await readFrames(response.body, options.handlers);
  } catch (error) {
    if (!options.signal.aborted) {
      options.handlers.onFailure(GENERIC_FAILURE_MESSAGE);
    }
    void error;
  }
}
