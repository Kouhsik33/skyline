// validate({ params, query, body }) — one implementation for both groups (A1).
//   - Parsed values go on req.valid = { params, query, body } for every controller.
//   - req.params and req.body are replaced by their parsed values (Group 1 controllers read them).
//   - req.query is never reassigned: in Express 5 it is a getter and assigning it throws. Code that
//     needs the parsed (coerced, defaulted) query reads req.valid.query.
// ZodErrors go to the error handler as 400 VALIDATION_FAILED.

export function validate(schemas = {}) {
  return (req, _res, next) => {
    try {
      const valid = {
        params: schemas.params ? schemas.params.parse(req.params) : { ...req.params },
        query: schemas.query ? schemas.query.parse(req.query) : { ...req.query },
        body: schemas.body ? schemas.body.parse(req.body ?? {}) : req.body,
      };
      req.valid = valid;
      if (schemas.params) req.params = valid.params;
      if (schemas.body) req.body = valid.body;
      next();
    } catch (err) {
      next(err);
    }
  };
}
