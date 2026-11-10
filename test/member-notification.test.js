const test = require('node:test');
const assert = require('node:assert/strict');
const {
  formatMemberContributionSms,
  normalizeE164PhoneNumber,
  sendTwilioSms
} = require('../src/member-notification');

test('formats a member notification with a total that excludes loan disbursements', () => {
  const message = formatMemberContributionSms({
    memberName: 'Amina',
    meetingDate: '05 Nov 2026',
    subgroupCode: 'B',
    currency: 'KES',
    fine: '10.25',
    social: '5.00',
    savings: '100.00',
    loanReturn: '20.00',
    loanTaken: '50.00'
  });

  assert.match(message, /Amina, Subgroup B, meeting 05 Nov 2026/);
  assert.match(message, /loan taken KES 50\.00/);
  assert.match(message, /Total paid KES 135\.25/);
});

test('normalizes display punctuation and validates international phone numbers', () => {
  assert.equal(normalizeE164PhoneNumber('+254 712-345-678'), '+254712345678');
  assert.equal(normalizeE164PhoneNumber('0712 345 678', '254'), '+254712345678');
  assert.equal(normalizeE164PhoneNumber('712345678', '254'), '+254712345678');
  assert.throws(() => normalizeE164PhoneNumber('123'), /international format/);
});

test('sends a Twilio message using authenticated form data', async () => {
  let request;
  const result = await sendTwilioSms({
    to: '+254 712-345-678',
    body: 'Meeting contribution details',
    env: {
      TWILIO_ACCOUNT_SID: `AC${'a'.repeat(32)}`,
      TWILIO_AUTH_TOKEN: 'test-token',
      TWILIO_FROM_NUMBER: '+254710537314',
      TWILIO_DEFAULT_COUNTRY_CODE: '254'
    },
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, status: 201, text: async () => '{"sid":"SM123"}' };
    }
  });

  assert.equal(result.messageSid, 'SM123');
  assert.match(request.url, /\/Accounts\/ACa{32}\/Messages\.json$/);
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers.Authorization, `Basic ${Buffer.from(`AC${'a'.repeat(32)}:test-token`).toString('base64')}`);
  assert.deepEqual(Object.fromEntries(request.options.body), {
    To: '+254712345678',
    From: '+254710537314',
    Body: 'Meeting contribution details'
  });
});

test('reports missing Twilio settings and provider errors', async () => {
  await assert.rejects(
    sendTwilioSms({ to: '+254712345678', body: 'test', env: {} }),
    /Twilio is not configured/
  );
  await assert.rejects(
    sendTwilioSms({
      to: '+254712345678',
      body: 'test',
      env: {
        TWILIO_ACCOUNT_SID: `AC${'a'.repeat(32)}`,
        TWILIO_AUTH_TOKEN: 'test-token',
        TWILIO_FROM_NUMBER: '+254700000000'
      },
      fetchImpl: async () => ({
        ok: false,
        status: 400,
        text: async () => '{"message":"The To phone number is invalid."}'
      })
    }),
    /The To phone number is invalid/
  );
});

test('explains how to resolve Twilio trial recipient verification errors', async () => {
  await assert.rejects(
    sendTwilioSms({
      to: '+254712345678',
      body: 'test',
      env: {
        TWILIO_ACCOUNT_SID: `AC${'a'.repeat(32)}`,
        TWILIO_AUTH_TOKEN: 'test-token',
        TWILIO_FROM_NUMBER: '+254700000000'
      },
      fetchImpl: async () => ({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({
          code: 21608,
          message: 'The number is not verified for this trial account.'
        })
      })
    }),
    /trial accounts can only message verified recipients.*Verified Caller IDs.*upgrade the Twilio account/
  );
});
