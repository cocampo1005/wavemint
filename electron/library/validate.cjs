// Small parameter validators for library IPC. Every renderer call is checked
// against a schema; unknown keys are dropped, wrong types are rejected.

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.code = "invalid";
  }
}

const v = {
  int: ({ min = 1, max = Number.MAX_SAFE_INTEGER, optional = false } = {}) => (value, name) => {
    if (value === undefined || value === null) {
      if (optional) return undefined;
      throw new ValidationError(`${name} is required`);
    }
    const number = Number(value);
    if (!Number.isInteger(number) || number < min || number > max) throw new ValidationError(`${name} is invalid`);
    return number;
  },
  str: ({ max = 500, optional = true, allowEmpty = true } = {}) => (value, name) => {
    if (value === undefined || value === null) {
      if (optional) return undefined;
      throw new ValidationError(`${name} is required`);
    }
    if (typeof value !== "string") throw new ValidationError(`${name} must be text`);
    if (!allowEmpty && !value.trim()) throw new ValidationError(`${name} is required`);
    return value.slice(0, max);
  },
  bool: ({ optional = true } = {}) => (value, name) => {
    if (value === undefined || value === null) {
      if (optional) return undefined;
      throw new ValidationError(`${name} is required`);
    }
    if (typeof value !== "boolean") throw new ValidationError(`${name} must be true or false`);
    return value;
  },
  oneOf: (values, { optional = true } = {}) => (value, name) => {
    if (value === undefined || value === null) {
      if (optional) return undefined;
      throw new ValidationError(`${name} is required`);
    }
    if (!values.includes(value)) throw new ValidationError(`${name} is invalid`);
    return value;
  },
  array: (item, { max = 5000, optional = true } = {}) => (value, name) => {
    if (value === undefined || value === null) {
      if (optional) return undefined;
      throw new ValidationError(`${name} is required`);
    }
    if (!Array.isArray(value) || value.length > max) throw new ValidationError(`${name} is invalid`);
    return value.map((entry, index) => item(entry, `${name}[${index}]`));
  },
  obj: (shape, { optional = true } = {}) => (value, name) => {
    if (value === undefined || value === null) {
      if (optional) return undefined;
      throw new ValidationError(`${name} is required`);
    }
    if (typeof value !== "object" || Array.isArray(value)) throw new ValidationError(`${name} is invalid`);
    const out = {};
    for (const [key, check] of Object.entries(shape)) {
      const checked = check(value[key], `${name}.${key}`);
      if (checked !== undefined) out[key] = checked;
    }
    return out;
  },
  any: () => (value) => value,
};

function validate(schema, params) {
  return v.obj(schema, { optional: false })(params || {}, "params");
}

module.exports = { ValidationError, v, validate };
