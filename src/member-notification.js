
function normalizeE164PhoneNumber(value, defaultCountryCode = '') {
  const phoneNumber = typeof value === 'string'
    ? value.replace(/[\s()-]/g, '')
    : '';

  let normalized = phoneNumber;

  if (!phoneNumber.startsWith('+') && defaultCountryCode) {
    if (!/^[1-9]\d{0,2}$/.test(defaultCountryCode)) {
      throw new Error(
        'GALATEXT_DEFAULT_COUNTRY_CODE must contain one to three digits.'
      );
    }

    if (/^\d+$/.test(phoneNumber)) {
      normalized = phoneNumber.startsWith(defaultCountryCode)
        ? `+${phoneNumber}`
        : `+${defaultCountryCode}${phoneNumber.startsWith('0')
          ? phoneNumber.slice(1)
          : phoneNumber}`;
    }
  }

  if (!/^\+[1-9]\d{7,14}$/.test(normalized)) {
    throw new Error(
      'Member phone number must use international format, for example +254712345678.'
    );
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
    .reduce(
      (total, value) => total + Math.round(Number(value) * 100),
      0
    );

  const totalPaid = (totalPaidCents / 100).toFixed(2);

  return `HSMS: ${memberName}, Subgroup ${subgroupCode}, meeting ${meetingDate}. Fine ${currency} ${money(fine)}, social ${currency} ${money(social)}, savings ${currency} ${money(savings)}, loan return ${currency} ${money(loanReturn)}, loan taken ${currency} ${money(loanTaken)}. Total paid ${currency} ${totalPaid}.`;
}

async function sendGalatextSms({
  to,
  body,
  env = process.env,
  fetchImpl = fetch
}) {
  const apiKey = env.GALATEXT_API_KEY;
  const senderId = env.GALATEXT_SENDER_ID || 'GALATEX';

  if (!apiKey) {
    throw new Error(
      'Galatext is not configured. Set GALATEXT_API_KEY in your .env file.'
    );
  }

  if (!senderId.trim()) {
    throw new Error(
      'GALATEXT_SENDER_ID cannot be empty.'
    );
  }

  const recipient = normalizeE164PhoneNumber(
    to,
    env.GALATEXT_DEFAULT_COUNTRY_CODE || '254'
  );

  // Galatext's example uses the country code without a leading plus.
  const recipientNumber = recipient.replace(/^\+/, '');

  const baseUrl = (
    env.GALATEXT_API_URL || 'https://api.galatext.com'
  ).replace(/\/+$/, '');

  const url = `${baseUrl}/api/sms/send-api`;

  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify({
      senderId,
      recipients: [recipientNumber],
      message: body
    }),
    signal: AbortSignal.timeout(10000)
  });

  const responseText = await response.text();

  let payload = null;

  try {
    payload = responseText ? JSON.parse(responseText) : null;
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }
  }

  if (!response.ok) {
    const detail =
      payload && typeof payload.message === 'string'
        ? payload.message
        : payload && typeof payload.error === 'string'
          ? payload.error
          : `Galatext returned HTTP ${response.status}.`;

    throw new Error(`SMS could not be sent: ${detail}`);
  }

  // Do not assume a particular Galatext success-response structure.
  return {
    success: true,
    response: payload
  };
}

module.exports = {
  formatMemberContributionSms,
  normalizeE164PhoneNumber,
  sendGalatextSms
};
