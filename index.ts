import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core';
import { XbotConfigSchema } from './src/config.ts';
import { registerXbotPlugin } from './src/register.ts';

const plugin = {
  id: 'xbot',
  name: 'Xbot',
  description: 'OpenClaw channel that only talks to xchatbot',
  configSchema: XbotConfigSchema,
  register(api: OpenClawPluginApi) {
    registerXbotPlugin(api);
  },
};

export default plugin;
