// The JUDGE: deterministic, no LLM. It never trusts the shop or the auditors — it reads
// PayPal's own records and returns the ground truth, with the sandbox ids that prove it.
// Every finding Tamper reports is confirmed here or it is not reported at all.

// Did PayPal really capture `expected` for this capture id? (The amount-mismatch proof.)
export async function captureAmount(pp, captureId) {
  const cap = await pp.getCapture(captureId);
  return { captureId, paid: cap.amount.value, currency: cap.amount.currency_code, status: cap.status };
}

// Is this order actually paid, per PayPal — not per a browser "success" redirect?
export async function orderTruth(pp, orderId) {
  const order = await pp.getOrder(orderId);
  const cap = order.purchase_units?.[0]?.payments?.captures?.[0] ?? null;
  return {
    orderId,
    status: order.status,
    completed: order.status === "COMPLETED",
    capturedAmount: cap?.amount?.value ?? null,
    currency: cap?.amount?.currency_code ?? null,
  };
}

// How many times was one cart really charged? The orders its checkout produced, per PayPal.
export async function cartCharges(pp, orderIds) {
  const orders = await Promise.all(orderIds.map((id) => pp.getOrder(id)));
  const completed = orders.filter((o) => o.status === "COMPLETED");
  const total = completed.reduce((sum, o) => sum + Number(o.purchase_units?.[0]?.payments?.captures?.[0]?.amount?.value ?? 0), 0);
  return { completed: completed.length, total: total.toFixed(2) };
}

// Is this webhook event genuinely from PayPal? PayPal itself answers.
export async function webhookGenuine(pp, headers, event, rawBody) {
  const res = await pp.verifyWebhook(headers, event, rawBody);
  return { genuine: res.verification_status === "SUCCESS", status: res.verification_status };
}
