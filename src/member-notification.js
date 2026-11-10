function normalizeE164PhoneNumber(value, defaultCountryCode = '') {
  const phoneNumber = typeof value === 'string' ? value.replace(/[\s()-]/g, '') : '';
  let normalized = phoneNumber;
  if (!phoneNumber.startsWith('+') && defaultCountryCode) {
    if (!/^[1-9]\d{0,2}$/.test(defaultCountryCode)) {
      throw new Error('TWILIO_DEFAULT_COUNTRY_CODE must contain one to three digits.');
    }
    if (/^\d+$/.test(phoneNumber)) {
      normalized = phoneNumber.startsWith(defaultCountryCode)
        ? `+${phoneNumber}`
        : `+${defaultCountryCode}${phoneNumber.startsWith('0') ? phoneNumber.slice(1) : phoneNumber}`;
    }
  }
  if (!/^\+[1-9]\d{7,14}$/.test(normalized)) {
    throw new Error('Member phone number must use international format, for example +254712345678.');
  }
  return normalized;
}

function formatMemberContributionSms({
  memberName,
  meetingDate,
  subgroupCode,
  currency,
  fine,
  social,
  savings,
  loanReturn,
  loanTaken
}) {
  const money = (value) => Number(value).toFixed(2);
  const totalPaidCents = [fine, social, savings, loanReturn]
    .reduce((total, value) => total + Math.round(Number(value) * 100), 0);
  const totalPaid = (totalPaidCents / 100).toFixed(2);

  return `HSMS: ${memberName}, Subgroup ${subgroupCode}, meeting ${meetingDate}. Fine ${currency} ${money(fine)}, social ${currency} ${money(social)}, savings ${currency} ${money(savings)}, loan return ${currency} ${money(loanReturn)}, loan taken ${currency} ${money(loanTaken)}. Total paid ${currency} ${totalPaid}.`;
}

async function sendTwilioSms({ to, body, env = process.env, fetchImpl = fetch }) {
  const { TWILIO_ACCOUNT_SID: accountSid, TWILIO_AUTH_TOKEN: authToken, TWILIO_FROM_NUMBER: fromNumber } = env;
  if (!accountSid || !authToken || !fromNumber) {
    throw new Error('Twilio is not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM_NUMBER.');
  }
  if (!/^AC[a-f\d]{32}$/i.test(accountSid)) {
    throw new Error('TWILIO_ACCOUNT_SID must be a valid Twilio Account SID.');
  }
  const recipient = normalizeE164PhoneNumber(to, env.TWILIO_DEFAULT_COUNTRY_CODE || '254');
  const sender = normalizeE164PhoneNumber(fromNumber);
  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
  const credentials = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({ To: recipient, From: sender, Body: body }),
    signal: AbortSignal.timeout(10000)
  });
  const responseText = await response.text();
  let payload = null;
  try {
    payload = JSON.parse(responseText);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  if (!response.ok) {
    if (Number(payload && payload.code) === 21608) {
      throw new Error(
        'Twilio trial accounts can only message verified recipients. Verify this member’s phone number in Twilio Console under Phone Numbers > Manage > Verified Caller IDs, or upgrade the Twilio account.'
      );
    }
    const detail = payload && typeof payload.message === 'string'
      ? payload.message
      : `Twilio returned HTTP ${response.status}.`;
    throw new Error(`SMS could not be sent: ${detail}`);
  }
  if (!payload || typeof payload.sid !== 'string') {
    throw new Error('Twilio accepted an unexpected response; SMS delivery could not be confirmed.');
  }
  return { messageSid: payload.sid };
}

module.exports = { formatMemberContributionSms, normalizeE164PhoneNumber, sendTwilioSms };
