import net from 'net';
import crypto from 'crypto';

const CRLF = '\r\n';

export type AdcpErrorCode = 'timeout' | 'socket' | 'auth' | 'closed';

export class AdcpError extends Error {
  readonly code: AdcpErrorCode;

  constructor(message: string, code: AdcpErrorCode) {
    super(message);
    this.name = 'AdcpError';
    this.code = code;
  }
}

export interface AdcpClientOptions {
  host: string;
  port?: number;
  password?: string;
  timeout?: number;
}

/**
 * Minimal Sony ADCP (Advanced Display Control Protocol) client.
 *
 * Each command opens its own short-lived TCP connection (the projector's idle
 * timeout is 60s and connections are cheap), so there's no socket to go stale.
 * Calls are serialized through an internal promise chain so a poll and a
 * user-initiated command never race on the device.
 *
 * Handshake: on connect the projector sends either `NOKEY` (auth disabled) or a
 * random nonce. With a nonce we authenticate by sending the lowercase hex
 * SHA-256 of (nonce + password); a failed auth yields `err_auth`.
 */
export class AdcpClient {
  private readonly host: string;
  private readonly port: number;
  private readonly password: string;
  private readonly timeout: number;
  private chain: Promise<unknown> = Promise.resolve();

  constructor({ host, port = 53595, password = '', timeout = 5000 }: AdcpClientOptions) {
    this.host = host;
    this.port = port;
    this.password = password || '';
    this.timeout = timeout;
  }

  /**
   * Send one ADCP command (e.g. `power_status ?`, `picture_mode "game"`).
   * Resolves with the reply line, trimmed and with surrounding quotes removed
   * (so `"on"` -> `on`). Rejects with AdcpError on timeout/socket/auth failure.
   * `err_*` replies (other than err_auth) are returned as-is for the caller to interpret.
   */
  send(command: string): Promise<string> {
    const run = (): Promise<string> => this.exec(command);
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => { /* keep the chain alive past failures */ });
    return next;
  }

  private exec(command: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const socket = new net.Socket();
      let phase: 'greeting' | 'reply' = 'greeting';
      let buf = '';
      let settled = false;
      let timer: NodeJS.Timeout;

      const finish = (err: AdcpError | null, val?: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (err) reject(err);
        else resolve(val as string);
      };

      timer = setTimeout(
        () => finish(new AdcpError(`ADCP timeout for "${command}"`, 'timeout')),
        this.timeout,
      );

      const write = (line: string): boolean => socket.write(line + CRLF);

      const onLine = (raw: string): void => {
        const line = raw.trim();
        if (phase === 'greeting') {
          if (line === '') return;
          if (line.toUpperCase() === 'NOKEY') {
            phase = 'reply';
            write(command);
          } else {
            // Nonce challenge.
            if (!this.password) {
              finish(new AdcpError(
                'projector requires ADCP authentication but no password is configured',
                'auth',
              ));
              return;
            }
            const hash = crypto.createHash('sha256').update(line + this.password).digest('hex');
            phase = 'reply';
            write(hash);
            write(command);
          }
          return;
        }
        // phase === 'reply'
        if (line.toLowerCase() === 'err_auth') {
          finish(new AdcpError('ADCP authentication failed (wrong password)', 'auth'));
          return;
        }
        finish(null, line.replace(/^"(.*)"$/, '$1'));
      };

      socket.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8');
        let i: number;
        while ((i = buf.indexOf(CRLF)) !== -1) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + CRLF.length);
          onLine(line);
          if (settled) return;
        }
      });
      socket.on('error', (e: Error) => finish(new AdcpError(`ADCP socket error: ${e.message}`, 'socket')));
      socket.on('close', () => finish(new AdcpError('ADCP connection closed before reply', 'closed')));

      socket.connect(this.port, this.host);
    });
  }
}
