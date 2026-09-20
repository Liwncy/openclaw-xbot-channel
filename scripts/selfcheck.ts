import assert from 'node:assert/strict';
import { parseXbotInboundParams } from '../src/inbound.ts';
import {
  looksLikeToolDraft,
  mapOpenClawPayloadToReplies,
  normalizeOutboundText,
} from '../src/outbound.ts';
import {
  isContextOverflowAlreadyReset,
  isContextOverflowError,
  isContextOverflowNotice,
} from '../src/overflow.ts';

{
  const parsed = parseXbotInboundParams({
    messageId: '1',
    platform: 'golem',
    source: 'private',
    from: 'wxid_owner',
    content: '你好',
  });
  assert.equal(parsed.peer.kind, 'direct');
  assert.equal(parsed.platform, 'golem');
  assert.equal(parsed.senderId, 'wxid_owner');
  assert.equal(parsed.rawBody, '你好');
}

{
  const parsed = parseXbotInboundParams({
    messageId: '2',
    platform: 'web',
    source: 'group',
    from: 'wxid_a',
    roomId: '123@chatroom',
    content: '@小聪明儿 在吗',
    mediaUrl: 'https://cdn.example.com/a.jpg',
    mediaKind: 'image',
  });
  assert.equal(parsed.peer.kind, 'group');
  assert.equal(parsed.route.platform, 'web');
  assert.equal(parsed.route.groupId, '123@chatroom');
  assert.equal(parsed.mediaKind, 'image');
}

assert.throws(() => parseXbotInboundParams({ source: 'private', from: 'wxid_a', platform: 'golem' }));
assert.throws(() => parseXbotInboundParams({ messageId: '3', source: 'private', from: 'wxid_a' }));
console.log('✓ inbound parse');

{
  const replies = mapOpenClawPayloadToReplies({
    text: '看看',
    mediaUrl: 'https://cdn.example.com/a.jpg',
    type: 'image',
  });
  assert.equal(replies[0]?.type, 'image');
  assert.equal(replies[1]?.type, 'text');
}

{
  const replies = mapOpenClawPayloadToReplies({
    mediaUrl: 'C:\\tmp\\a.mp3',
    type: 'voice',
  });
  assert.equal(replies.length, 0);
}

{
  const replies = mapOpenClawPayloadToReplies({
    mediaUrl: 'https://cdn.example.com/v.mp3',
    audioAsVoice: true,
  });
  assert.equal(replies[0]?.type, 'voice');
}
console.log('✓ map replies (http only)');

assert.equal(normalizeOutboundText('**你好**'), '你好');
assert.equal(
  normalizeOutboundText('画好了\nimage:https://cdn.example.com/a.jpg'),
  '画好了\nimage:https://cdn.example.com/a.jpg',
);
assert.equal(
  normalizeOutboundText('<invoke name="emoji_get"><parameter name="md5">abc</parameter></invoke>'),
  '',
);
assert.equal(
  normalizeOutboundText('吃了吗\n<invoke name="read"><parameter name="file_path">x</parameter></invoke>'),
  '吃了吗',
);
assert.equal(
  normalizeOutboundText('<tool_use name="emoji_get"><parameter name="md5">abc</parameter></tool_use>'),
  '',
);
assert.equal(
  normalizeOutboundText('[Advisor review]\nThe assistant should: call the tool.\n吃了吗'),
  '吃了吗',
);
assert.equal(
  normalizeOutboundText('[系统提示：群聊随机接话] 不要输出 NO_REPLY [/系统提示]\n在吗'),
  '在吗',
);
assert.equal(normalizeOutboundText('NO_REPLY'), '');
assert.equal(normalizeOutboundText('[ERROR] TypeError: x'), '');
assert.equal(normalizeOutboundText('voice-clip.silk'), '');
assert.equal(looksLikeToolDraft('<invoke name="emoji_get"></invoke>'), true);
assert.equal(looksLikeToolDraft('NO_REPLY'), false);
console.log('✓ text normalize');

assert.equal(
  isContextOverflowNotice(
    '⚠️ Context is too large and auto-compaction could not recover this turn. Try again, use /compact, or use /new to start a fresh session.',
  ),
  true,
);
assert.equal(
  isContextOverflowNotice(
    '⚠️ Auto-compaction could not recover this turn. I kept this conversation mapped to the current session. Please try again, use /compact, or use /new to start a fresh session.',
  ),
  true,
);
assert.equal(isContextOverflowNotice('好了，撤了'), false);
assert.equal(
  isContextOverflowAlreadyReset(
    "⚠️ Context limit exceeded. I've reset our conversation to start fresh - please try again.",
  ),
  true,
);
assert.equal(
  isContextOverflowError(new Error('Context is too large and auto-compaction could not recover this turn.')),
  true,
);
console.log('✓ overflow notice detect');
