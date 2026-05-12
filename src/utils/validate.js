import { HttpError } from '../middleware/error.js';

/**
 * Validate `req.body` against a zod schema. Throws HttpError(400) with
 * field-level details on failure. Returns the parsed (and typed) value.
 *
 *   const data = validateBody(req, schema);
 */
export function validateBody(req, schema) {
  const result = schema.safeParse(req.body);
  if (!result.success) {
    const issues = result.error.flatten().fieldErrors;
    const first = Object.entries(issues)[0];
    const message = first ? `${first[0]}: ${first[1]?.[0]}` : 'Invalid request body';
    throw new HttpError(400, message);
  }
  return result.data;
}
