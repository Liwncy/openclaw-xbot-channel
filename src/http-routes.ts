import type { IncomingMessage, ServerResponse } from 'node:http';
import type { GatewayRequestHandlerOptions } from 'openclaw/plugin-sdk/core';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core';
import type { XbotBridge } from './bridge.ts';

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }
  return parsed as Record<string, unknown>;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function buildGatewayHandlerContext(
  params: Record<string, unknown>,
  respond: GatewayRequestHandlerOptions['respond'],
): GatewayRequestHandlerOptions {
  return {
    req: { id: 'http', type: 'req', method: 'xbot.http' } as GatewayRequestHandlerOptions['req'],
    params,
    client: null,
    isWebchatConnect: () => false,
    respond,
    context: {} as GatewayRequestHandlerOptions['context'],
  };
}

function runGatewayHandler(
  bridge: XbotBridge,
  method: 'connect' | 'inbound' | 'activity',
  params: Record<string, unknown>,
  res: ServerResponse,
): Promise<void> {
  return new Promise((resolve) => {
    const respond: GatewayRequestHandlerOptions['respond'] = (ok, payload) => {
      sendJson(res, ok ? 200 : 400, { ok, ...(payload || {}) });
      resolve();
    };
    const ctx = buildGatewayHandlerContext(params, respond);
    if (method === 'connect') {
      void bridge.handleConnect(ctx).catch((error) => {
        sendJson(res, 500, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
        resolve();
      });
      return;
    }
    if (method === 'inbound') {
      void bridge.handleInbound(ctx).catch((error) => {
        sendJson(res, 500, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
        resolve();
      });
      return;
    }
    void bridge.handleActivity(ctx).catch((error) => {
      sendJson(res, 500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
      resolve();
    });
  });
}

export function registerXbotHttpRoutes(
  api: OpenClawPluginApi,
  getBridge: () => XbotBridge,
): void {
  const routes = [
    { path: '/api/channels/xbot/connect', method: 'connect' as const },
    { path: '/api/channels/xbot/inbound', method: 'inbound' as const },
    { path: '/api/channels/xbot/activity', method: 'activity' as const },
  ];

  for (const route of routes) {
    api.registerHttpRoute({
      path: route.path,
      auth: 'gateway',
      match: 'exact',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'Method Not Allowed' });
          return true;
        }
        try {
          const params = await readJsonBody(req);
          await runGatewayHandler(getBridge(), route.method, params, res);
        } catch (error) {
          sendJson(res, 400, {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return true;
      },
    });
  }
}
