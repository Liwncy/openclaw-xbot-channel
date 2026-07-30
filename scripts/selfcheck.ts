import assert from 'node:assert/strict';
import {
  extractOpenClawMediaFromText,
  isPlausibleMediaRef,
  mapOpenClawPayloadToReplies,
} from '../src/outbound/map-reply.ts';
import { isAgentSuccessStage } from '../src/outbound/delivery.ts';
import { isRetryableOutboundError } from '../src/outbound/http-outbox.ts';
import {
  isValidSilkPayload,
  isLikelyAlreadySilk,
  MIN_SILK_BYTES,
} from '../src/outbound/local-silk-convert.ts';
import { parseXbotParamMarker } from '../src/outbound/xbot-param.ts';

function section(name: string): void {
  console.log(`✓ ${name}`);
}

// isPlausibleMediaRef
assert.equal(isPlausibleMediaRef('tts:'), false);
assert.equal(isPlausibleMediaRef('tts'), false);
assert.equal(isPlausibleMediaRef('C:\\Users\\a\\voice-1.mp3'), true);
assert.equal(isPlausibleMediaRef('https://example.com/a.mp4'), true);
section('isPlausibleMediaRef');

// MEDIA:voice|path
{
  const extracted = extractOpenClawMediaFromText('先听这个\nMEDIA:voice|C:\\tmp\\a.mp3\n');
  assert.equal(extracted.mediaItems.length, 1);
  assert.equal(extracted.mediaItems[0]?.hintedType, 'voice');
  assert.equal(extracted.audioAsVoice, true);
  assert.match(extracted.text, /先听这个/);
  assert.doesNotMatch(extracted.text, /MEDIA:/);
}
section('MEDIA:voice|path');

// MEDIA:video:path
{
  const extracted = extractOpenClawMediaFromText('MEDIA:video:D:/clips/demo.mp4');
  assert.equal(extracted.mediaItems[0]?.hintedType, 'video');
  assert.equal(extracted.mediaItems[0]?.url.replace(/\\/g, '/'), 'D:/clips/demo.mp4');
}
section('MEDIA:video:path');

// XbotParam
{
  const parsed = parseXbotParamMarker(
    '你好 [XbotParam:{"asVoice":true,"type":"voice","path":"C:\\\\tmp\\\\v.mp3"}] 世界',
  );
  assert.equal(parsed.params.asVoice, true);
  assert.equal(parsed.params.type, 'voice');
  assert.match(parsed.cleanText, /你好/);
  assert.match(parsed.cleanText, /世界/);
  assert.doesNotMatch(parsed.cleanText, /XbotParam/);

  const replies = mapOpenClawPayloadToReplies({ text: parsed.cleanText + '\n' });
  // path already stripped with marker; map via extract on original
  const fromFull = mapOpenClawPayloadToReplies({
    text: '你好 [XbotParam:{"asVoice":true,"type":"voice","path":"C:\\\\tmp\\\\v.mp3"}]',
  });
  assert.equal(fromFull.some((item) => item.type === 'voice'), true);
}
section('XbotParam voice path');

// delivery stages
assert.equal(isAgentSuccessStage('wechat-ok'), true);
assert.equal(isAgentSuccessStage('deduped'), true);
assert.equal(isAgentSuccessStage('queued'), false);
assert.equal(isAgentSuccessStage('partial'), false);
assert.equal(isAgentSuccessStage('failed'), false);
section('delivery stages');

// payload media + caption
{
  const replies = mapOpenClawPayloadToReplies({
    text: '看看',
    mediaUrl: 'C:\\tmp\\x.mp4',
    type: 'video',
  });
  assert.equal(replies[0]?.type, 'video');
  assert.equal(replies.some((item) => item.type === 'text' && item.content.includes('看看')), true);
}
section('payload video + caption');

// retryable classifier
assert.equal(isRetryableOutboundError('HTTP 502 failedCount=1'), true);
assert.equal(isRetryableOutboundError('fetch timeout after 90000ms'), true);
assert.equal(isRetryableOutboundError('silk convert failed'), false);
assert.equal(isRetryableOutboundError('local media too large: 12000KB > 8MB'), false);
assert.equal(isRetryableOutboundError('HTTP 400 bad request'), false);
section('retryable classifier');

// silk payload validation（挡住 ~93B 脏包）
{
  const junk = Uint8Array.from({ length: 93 }, (_, i) => i);
  assert.equal(isValidSilkPayload(junk), false);
  const header = Buffer.from(`\x02${'#!SILK_V3'}`, 'binary');
  const pad = Buffer.alloc(Math.max(0, MIN_SILK_BYTES - header.length), 1);
  const ok = Buffer.concat([header, pad]);
  assert.equal(isValidSilkPayload(ok), true);
  assert.equal(isLikelyAlreadySilk({ format: 4, mediaId: 'short' }), false);
  assert.equal(
    isLikelyAlreadySilk({ format: 4, mediaId: ok.toString('base64') }),
    true,
  );
}
section('silk payload validation');

console.log('\nselfcheck passed');
