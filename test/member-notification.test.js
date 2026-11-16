
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  formatMemberContributionSms,
  normalizeE164PhoneNumber,
  sendGalatextSms
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

test('normalizes Kenyan and international phone numbers', () => {
  assert.equal(
    normalizeE164PhoneNumber('+254 712-345-678'),
    '+254712345678'
  );

  assert.equal(
    normalizeE164PhoneNumber('0712 345 678', '254'),
    '+254712345678'
  );

  assert.equal(
    normalizeE164PhoneNumber('712345678', '254'),
    '+254712345678'
  );

  assert.throws(
    () => normalizeE164PhoneNumber('123'),
    /international format/
  );
});

test('sends a Galatext SMS using the correct API request', async () => {
  let request;

  const result = await sendGalatextSms({
    to: '+254 712-345-678',
    body: 'Meeting contribution details',

    env: {
      GALATEXT_API_KEY: 'test-api-key',
      GALATEXT_API_URL: 'https://api.galatext.com',
      GALATEXT_SENDER_ID: 'GALATEX',
      GALATEXT_DEFAULT_COUNTRY_CODE: '254'
    },

    fetchImpl: async (url, options) => {
      request = { url, options };

      return {
        ok: true,
        status: 200,
        text: async () => '{"success":true}'
      };
    }
  });

  assert.equal(result.success, true);

  assert.equal(
    request.url,
    'https://api.galatext.com/api/sms/send-api'
  );

  assert.equal(request.options.method, 'POST');

  assert.equal(
    request.options.headers['x-api-key'],
    'test-api-key'
  );

  assert.equal(
    request.options.headers['Content-Type'],
    'application/json'
  );

  assert.deepEqual(
    JSON.parse(request.options.body),
    {
      senderId: 'GALATEX',
      recipients: ['254712345678'],
      message: 'Meeting contribution details'
    }
  );
});

test('reports missing Galatext API configuration', async () => {
  await assert.rejects(
    sendGalatextSms({
      to: '+254712345678',
      body: 'Test message',
      env: {}
    }),
    /Galatext is not configured/
  );
});

test('reports Galatext API errors', async () => {
  await assert.rejects(
    sendGalatextSms({
      to: '+254712345678',
      body: 'Test message',

      env: {
        GALATEXT_API_KEY: 'test-api-key',
        GALATEXT_SENDER_ID: 'GALATEX'
      },

      fetchImpl: async () => ({
        ok: false,
        status: 400,
        text: async () =>
          '{"message":"Invalid recipient number."}'
      })
    }),

    /Invalid recipient number/
  );
});

test('handles a successful response with an empty body', async () => {
  const result = await sendGalatextSms({
    to: '+254712345678',
    body: 'Test message',

    env: {
      GALATEXT_API_KEY: 'test-api-key',
      GALATEXT_SENDER_ID: 'GALATEX'
    },

    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => ''
    })
  });

  assert.equal(result.success, true);
  assert.equal(result.response, null);
});
