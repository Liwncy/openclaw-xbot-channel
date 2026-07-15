import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core';
import { getXbotBridge } from './src/bridge.ts';
import { createXbotChannelPlugin } from './src/channel-plugin.ts';
import { XbotConfigSchema } from './src/config-schema.ts';
import { GATEWAY_METHODS } from './src/constants.ts';
import { registerXbotHttpRoutes } from './src/http-routes.ts';

type GatewayRuntime = {
  bridge?: ReturnType<typeof getXbotBridge>;
  serviceRegistered: boolean;
  channelRegistered: boolean;
  methodsRegistered: boolean;
};

const gatewayRuntimeSymbol = Symbol.for('xbot.gateway.runtime');

function getGatewayRuntime(): GatewayRuntime {
  const proc = process as NodeJS.Process & { [gatewayRuntimeSymbol]?: GatewayRuntime };
  if (!proc[gatewayRuntimeSymbol]) {
    proc[gatewayRuntimeSymbol] = {
      serviceRegistered: false,
      channelRegistered: false,
      methodsRegistered: false,
    };
  }
  return proc[gatewayRuntimeSymbol]!;
}

function getCurrentBridge(api: OpenClawPluginApi) {
  const runtime = getGatewayRuntime();
  if (!runtime.bridge) runtime.bridge = getXbotBridge(api);
  return runtime.bridge;
}

const plugin = {
  id: 'xbot',
  name: 'Xbot',
  description: 'xchatbot WeChat channel plugin',
  configSchema: XbotConfigSchema,
  register(api: OpenClawPluginApi) {
    const runtime = getGatewayRuntime();
    const bridge = getCurrentBridge(api);

    if (!runtime.serviceRegistered) {
      api.registerService({
        id: 'xbot-bridge-service',
        start: async () => {},
        stop: async () => {},
      });
      runtime.serviceRegistered = true;
    }

    if (!runtime.channelRegistered) {
      api.registerChannel({
        plugin: createXbotChannelPlugin(() => getCurrentBridge(api)) as never,
      });
      runtime.channelRegistered = true;
    }

    if (!runtime.methodsRegistered) {
      for (const method of GATEWAY_METHODS) {
        api.registerGatewayMethod(method, (opts) => {
          if (method === 'xbot.connect') return bridge.handleConnect(opts);
          if (method === 'xbot.inbound') return bridge.handleInbound(opts);
          if (method === 'xbot.activity') return bridge.handleActivity(opts);
          opts.respond(false, { ok: false, error: `unsupported method: ${method}` });
        });
      }
      runtime.methodsRegistered = true;
    }

    registerXbotHttpRoutes(api, () => getCurrentBridge(api));
  },
};

export default plugin;
