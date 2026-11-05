exports.authGetTokenForAuthInfo = async info => {
  const identity = JSON.parse(info);
  if (identity.type !== 'user' || identity.host !== 'https://github.com') throw new Error('unexpected auth identity');
  if (identity.login === 'error') throw new Error('native-error-with-synthetic-secret');
  if (identity.login === 'missing') return null;
  return 'synthetic-ipc-token';
};
