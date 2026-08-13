import type { Server } from 'http';

/** Bind an HTTP server and return the actual TCP port, including for port 0. */
export function listenHttpServer(server: Server, port: number, host: string): Promise<number> {
  if (server.listening) {
    return Promise.reject(new Error('HTTP server is already listening'));
  }

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      server.off('error', onError);
      server.off('listening', onListening);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onListening = () => {
      cleanup();
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('HTTP server did not expose a TCP address'));
        return;
      }
      resolve(address.port);
    };

    server.once('error', onError);
    server.once('listening', onListening);
    try {
      server.listen(port, host);
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

/** Stop accepting work and bound shutdown even when a client keeps a socket open. */
export function closeHttpServer(server: Server, timeoutMs = 5_000): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      server.closeAllConnections?.();
      finish();
    }, timeoutMs);
    timer.unref?.();
    server.close((error) => finish(error));
    server.closeIdleConnections?.();
  });
}
