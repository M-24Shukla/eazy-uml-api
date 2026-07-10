import { getAuth } from '@clerk/express';

const unauthorized = () => {
  const error = new Error('Authentication required.');
  error.status = 401;
  error.code = 'AUTH_REQUIRED';
  return error;
};

export const requireAuth = async (request, _response, next) => {
  const auth = getAuth(request);

  if (!auth.isAuthenticated || !auth.userId) {
    next(unauthorized());
    return;
  }

  request.auth = auth;

  next();
};
