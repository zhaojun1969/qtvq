/** 统一的 JSON 响应与错误类型 */

export class ApiError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code || `E${status}`;
  }
}

export function badRequest(message, code) {
  return new ApiError(400, message, code);
}

export function unauthorized(message = '未登录或会话已过期') {
  return new ApiError(401, message, 'E401');
}

export function notFound(message = '资源不存在') {
  return new ApiError(404, message, 'E404');
}

export function ok(res, data) {
  return res.json({ code: 0, data });
}

/** 统一错误出口：永远不要把内部堆栈返回给客户端 */
export function errorHandler(err, req, res, _next) {
  const status = err instanceof ApiError ? err.status : 500;
  if (status >= 500) console.error('[error]', req.method, req.originalUrl, err);
  res.status(status).json({
    code: status,
    error: status >= 500 ? '服务器错误' : err.message,
    ...(err instanceof ApiError && err.code ? { errorCode: err.code } : {}),
  });
}

/** 包住 async 路由，异常交给 errorHandler */
export function wrap(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}
