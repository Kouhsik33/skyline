// Parses params/query/body with zod. The parsed values are exposed two ways: replacing
// req.params / req.query / req.body (Group 1 controllers) and as req.valid.{params,query,body}
// (Group 2 controllers). Parts a route does not validate are passed through unparsed.
export function validate(schemas = {}) {
  return (req, _res, next) => {
    try {
      const valid = { params: req.params, query: req.query, body: req.body };
      if (schemas.params) req.params = valid.params = schemas.params.parse(req.params);
      if (schemas.query) {
        valid.query = schemas.query.parse(req.query);
        // Express 5 exposes req.query as a getter, so assigning to it throws; shadow it instead.
        Object.defineProperty(req, 'query', { value: valid.query, writable: true, configurable: true, enumerable: true });
      }
      if (schemas.body) req.body = valid.body = schemas.body.parse(req.body);
      req.valid = valid;
      next();
    } catch (err) {
      next(err);
    }
  };
}
