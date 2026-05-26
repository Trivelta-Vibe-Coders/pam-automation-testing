/**
 * POST /webhook/jira
 *
 * Receives Jira webhook events. Optionally verifies HMAC-SHA256 signature
 * (set JIRA_WEBHOOK_SECRET to enable).
 */
import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { JiraWebhookPayload } from '../types';
import * as logger from '../logger';
import { handleTicketCreated } from '../handlers/ticket-created';
import { handleTicketUpdated } from '../handlers/ticket-updated';
import { config } from '../config';

export const webhookRouter = Router();

// ── Signature verification ────────────────────────────────────────────────────

function verifySignature(rawBody: Buffer, signature: string): boolean {
  if (!config.jiraWebhookSecret) return true;  // verification disabled
  const expected = crypto
    .createHmac('sha256', config.jiraWebhookSecret)
    .update(rawBody)
    .digest('hex');
  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature.replace(/^sha256=/, '')),
      Buffer.from(expected),
    );
  } catch {
    return false;
  }
}

// ── Main route ────────────────────────────────────────────────────────────────

webhookRouter.post('/', async (req: Request, res: Response) => {
  // Verify signature if secret is configured
  const sig = req.headers['x-hub-signature-256'] as string | undefined
           ?? req.headers['x-hub-signature']      as string | undefined;

  if (config.jiraWebhookSecret) {
    if (!sig || !verifySignature((req as any).rawBody ?? Buffer.alloc(0), sig)) {
      logger.warn('Jira webhook: invalid signature — rejected');
      res.status(401).json({ error: 'Invalid signature' });
      return;
    }
  }

  const payload = req.body as JiraWebhookPayload;
  const event   = payload.webhookEvent;

  // Acknowledge immediately (Jira expects < 5s response)
  res.status(200).json({ ok: true, event });

  if (!payload.issue) {
    logger.warn(`Webhook received without issue object (event: ${event})`);
    return;
  }

  const key = payload.issue.key ?? 'UNKNOWN';

  // Only process PAMENG tickets (guard against cross-project webhooks)
  if (!key.startsWith(config.jiraProject)) {
    logger.info(`Ignoring webhook for non-PAMENG issue: ${key}`);
    return;
  }

  logger.info(`Webhook received: ${event} for ${key}`);

  try {
    if (event === 'jira:issue_created') {
      await handleTicketCreated(payload.issue);
    } else if (event === 'jira:issue_updated') {
      await handleTicketUpdated(payload);
    } else {
      logger.info(`Ignoring unhandled event type: ${event}`);
    }
  } catch (err) {
    logger.error(`Unhandled error processing ${event} for ${key}`, {
      error: String(err),
    });
  }
});
