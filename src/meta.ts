import { CHANNEL_ID } from './constants.ts';

export const XBOT_CHANNEL_META = {
  id: CHANNEL_ID,
  label: 'Xbot',
  selectionLabel: 'xchatbot WeChat',
  docsPath: '/channels/xbot',
  blurb: 'xchatbot WeChat channel via gateway push.',
  aliases: ['xbot', 'wechat', 'xchatbot'],
  preferSessionLookupForAnnounceTarget: true,
};
