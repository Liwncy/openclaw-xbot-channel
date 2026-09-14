import assert from 'node:assert/strict';
import { parseXbotInboundParams } from '../src/inbound.ts';
import { mapOpenClawPayloadToReplies, normalizeOutboundText } from '../src/outbound.ts';

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
console.log('✓ text normalize');
