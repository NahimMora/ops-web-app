import { randomUUID } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { config } from "./config.js";
import type { Repository, SessionRecord, UserRecord } from "./repository.js";
import { decryptSecret, encryptSecret, hashPassword, randomToken, safeEqual, tokenHash, verifyPassword } from "./security.js";
import { generateTotpSecret, totpUri, verifyTotp } from "./totp.js";

const cookieName = "hsops_session";
const loginSchema = z.object({ email: z.string().email(), password: z.string().min(8).max(512), totpCode: z.string().regex(/^\d{6}$/).optional() }).strict();

export interface AuthContext { user: UserRecord; session: SessionRecord; }

export class AuthService {
  constructor(private readonly repository: Repository) {}

  async login(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) return void reply.code(400).send({ error: "INVALID_REQUEST", message: "Datos de acceso invalidos" });
    const email = parsed.data.email.trim().toLowerCase();
    const user = await this.repository.findUserByEmail(email);
    const dummyHash = user?.passwordHash || await hashPassword("dummy-password-used-only-for-timing");
    const passwordOk = await verifyPassword(parsed.data.password, dummyHash);
    const locked = user?.lockedUntil && Date.parse(user.lockedUntil) > Date.now();
    if (!user || user.status !== "active" || !passwordOk || locked) {
      if (user) {
        const failures = user.failedLoginCount + 1;
        const lockUntil = failures >= 5 ? new Date(Date.now() + 15 * 60_000).toISOString() : null;
        await this.repository.recordLoginResult(user.id, false, lockUntil);
      }
      await this.repository.addAudit({ actorType: "anonymous", actorId: null, action: "auth.login", targetType: "user", targetId: null, result: "denied", metadata: {} });
      return void reply.code(401).send({ error: "INVALID_CREDENTIALS", message: "Credenciales invalidas" });
    }
    if (user.totpEnabled) {
      if (!parsed.data.totpCode) return void reply.code(401).send({ error: "TOTP_REQUIRED", message: "Ingresa el codigo de autenticacion" });
      const secret = user.totpSecretEncrypted ? decryptSecret(user.totpSecretEncrypted, config.totpEncryptionKey) : "";
      if (!secret || !verifyTotp(secret, parsed.data.totpCode)) {
        await this.repository.recordLoginResult(user.id, false, null);
        return void reply.code(401).send({ error: "INVALID_TOTP", message: "Codigo invalido" });
      }
    }
    await this.repository.recordLoginResult(user.id, true);
    const rawToken = randomToken(); const csrfToken = randomToken();
    const session: SessionRecord = { id: randomUUID(), userId: user.id, tokenHash: tokenHash(rawToken, config.sessionSecret), csrfTokenHash: tokenHash(csrfToken, config.sessionSecret), expiresAt: new Date(Date.now() + config.sessionTtlMs).toISOString(), revokedAt: null };
    await this.repository.createSession(session);
    setSessionCookie(reply, rawToken);
    await this.repository.addAudit({ actorType: "user", actorId: user.id, action: "auth.login", targetType: "session", targetId: session.id, result: "success", metadata: {} });
    reply.send({ user: publicUser(user), csrfToken });
  }

  async context(request: FastifyRequest): Promise<AuthContext | null> {
    const raw = request.cookies[cookieName]; if (!raw) return null;
    const session = await this.repository.getSession(tokenHash(raw, config.sessionSecret)); if (!session) return null;
    const user = await this.repository.getUser(session.userId); if (!user || user.status !== "active") return null;
    return { user, session };
  }

  async requireUser(request: FastifyRequest, reply: FastifyReply, csrf = false): Promise<AuthContext | null> {
    const context = await this.context(request);
    if (!context) { reply.code(401).send({ error: "AUTH_REQUIRED", message: "Autenticacion requerida" }); return null; }
    if (csrf) {
      const provided = String(request.headers["x-csrf-token"] ?? "");
      if (!provided || !safeEqual(tokenHash(provided, config.sessionSecret), context.session.csrfTokenHash)) {
        reply.code(403).send({ error: "CSRF_INVALID", message: "Token CSRF invalido" }); return null;
      }
    }
    return context;
  }

  async me(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const context = await this.requireUser(request, reply); if (!context) return;
    reply.send({ user: publicUser(context.user) });
  }
  async csrf(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const context = await this.requireUser(request, reply); if (!context) return;
    const raw = randomToken(); await this.repository.rotateSessionCsrf(context.session.id, tokenHash(raw, config.sessionSecret)); reply.send({ csrfToken: raw });
  }
  async logout(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const context = await this.requireUser(request, reply, true); if (!context) return;
    await this.repository.revokeSession(context.session.id); clearSessionCookie(reply); reply.send({ ok: true });
  }
  async revokeAll(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const context = await this.requireUser(request, reply, true); if (!context) return;
    await this.repository.revokeUserSessions(context.user.id); clearSessionCookie(reply); reply.send({ ok: true });
  }
  async setupTotp(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const context = await this.requireUser(request, reply, true); if (!context) return;
    const secret = generateTotpSecret(); await this.repository.setUserTotp(context.user.id, encryptSecret(secret, config.totpEncryptionKey), false);
    reply.send({ secret, uri: totpUri(secret, context.user.email) });
  }
  async enableTotp(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const context = await this.requireUser(request, reply, true); if (!context) return;
    const code = z.object({ code: z.string().regex(/^\d{6}$/) }).safeParse(request.body);
    const freshUser = await this.repository.getUser(context.user.id); const encrypted = freshUser?.totpSecretEncrypted;
    if (!code.success || !encrypted || !verifyTotp(decryptSecret(encrypted, config.totpEncryptionKey), code.data.code)) return void reply.code(400).send({ error: "INVALID_TOTP", message: "Codigo invalido" });
    await this.repository.setUserTotp(context.user.id, encrypted, true); reply.send({ ok: true });
  }
}

function setSessionCookie(reply: FastifyReply, token: string) { reply.setCookie(cookieName, token, { path: "/", httpOnly: true, secure: config.nodeEnv === "production", sameSite: "strict", maxAge: Math.floor(config.sessionTtlMs / 1000) }); }
function clearSessionCookie(reply: FastifyReply) { reply.clearCookie(cookieName, { path: "/" }); }
function publicUser(user: UserRecord) { return { id: user.id, email: user.email, displayName: user.displayName, role: user.role, totpEnabled: user.totpEnabled }; }
