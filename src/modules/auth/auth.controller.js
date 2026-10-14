import * as authService from './auth.service.js';

export async function register(req, res) {
  const user = await authService.registerUser(req.valid.body);
  res.status(201).json({
    data: { user: { id: user.id, email: user.email, createdAt: user.created_at } },
  });
}

export async function login(req, res) {
  const { token, expiresAt, user } = await authService.loginUser(req.valid.body);
  res.set('Cache-Control', 'no-store'); // a response containing a credential must not be cached
  res.status(200).json({
    data: {
      token,
      expiresAt,
      user: { id: user.id, email: user.email, createdAt: user.created_at },
    },
  });
}

export async function me(req, res) {
  res.status(200).json({ data: { user: req.user } });
}

export async function logout(req, res) {
  await authService.logout(req.sessionId);
  res.status(204).end();
}