#include <math.h>
#include <limits.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "lua.h"
#include "lauxlib.h"
#include "lualib.h"
#include "lstate.h"

#include <emscripten/emscripten.h>

/* Native hooks compile away in the unchanged legacy ABI. */
#ifndef PDRV_NATIVE_ITERATION
#define PDRV_NATIVE_ITERATION() ((void)0)
#define PDRV_NATIVE_BLOCKS(n) ((void)0)
#define pdrv_scratch_malloc malloc
#define pdrv_scratch_calloc calloc
#define pdrv_scratch_realloc realloc
#define pdrv_scratch_free free
#endif

#define PDRV_LUA_VM_ARTIFACT_CONTRACT 11u
#define PDRV_ABI_MALFORMED -1
#define PDRV_ABI_CAPACITY -2
#define PDRV_ABI_NONFINITE -3
#define PDRV_ABI_NEGATIVE_ZERO -4
#define PDRV_ABI_FORBIDDEN -5
#define PDRV_ENV_SOURCE -6
#define PDRV_ENV_PROGRAM -7
#define PDRV_ENV_INVALID_TEXT -8
#define PDRV_ENV_MISSING_VALUE -10
#define PDRV_ENV_ARRAY_SHAPE -11
#define PDRV_ENV_RECORD_KEY -12
#define PDRV_ENV_CYCLE -13
#define PDRV_ENV_BOUNDARY -14
#define PDRV_REQUIRE_MISSING -15
#define PDRV_REQUIRE_INITIALIZATION_CYCLE -16
#define PDRV_RESOURCE_ALLOCATION -17
#define PDRV_RESOURCE_FUEL -18
#define PDRV_ENV_ADMISSION_EXPORTS -19
#define PDRV_ENV_INVOCATION_EXPORT -20
#define PDRV_ENV_POINTER_RENDERING -21
#define PDRV_ENV_INTEGER_DECIMAL -22
#define PDRV_ENV_INTEGER_RANGE -23
#define PDRV_ENV_VARIANT_TAG -24
#define PDRV_ENV_VARIANT_VALUE -25

#define PDRV_BOUNDARY_MAGIC 0x50445242u
#define PDRV_FAILURE_MAGIC 0x50445246u

typedef struct {
  const uint8_t *cursor;
  const uint8_t *end;
} Reader;

typedef struct {
  uint8_t *bytes;
  uint32_t length;
  uint32_t capacity;
} Writer;

typedef struct {
  uint32_t magic;
} AuthoredBoundary;

typedef struct {
  uint32_t magic;
} NamedFailure;

typedef struct {
  const void **tables;
  size_t length;
  size_t capacity;
} ConversionStack;

typedef struct {
  const char *bytes;
  size_t length;
} RecordKey;

typedef struct {
  char *bytes;
  size_t length;
} EnvironmentMember;

typedef struct {
  uint64_t allocation_current;
  uint64_t allocation_limit;
  uint32_t fuel_used;
  uint32_t fuel_limit;
  int fuel_exhausted;
  int allocation_exhausted;
} ExecutionLimits;

typedef struct {
  ExecutionLimits limits;
  lua_State *state;
  int used;
} InvocationHandle;

extern int32_t pdrv_lua_require_source(
    const uint8_t *name, uint32_t name_length,
    uint8_t *output, uint32_t output_capacity)
    __attribute__((import_module("env"), import_name("pdrv_lua_require_source")));

static int read_u8(Reader *reader, uint8_t *value) {
  if (reader->cursor == reader->end) return 0;
  *value = *reader->cursor++;
  return 1;
}

static int read_u32(Reader *reader, uint32_t *value) {
  if ((size_t)(reader->end - reader->cursor) < 4u) return 0;
  *value = ((uint32_t)reader->cursor[0] << 24)
    | ((uint32_t)reader->cursor[1] << 16)
    | ((uint32_t)reader->cursor[2] << 8)
    | (uint32_t)reader->cursor[3];
  reader->cursor += 4;
  return 1;
}

static int read_region(Reader *reader, uint32_t length, Reader *region) {
  if ((size_t)(reader->end - reader->cursor) < length) return 0;
  region->cursor = reader->cursor;
  region->end = reader->cursor + length;
  reader->cursor += length;
  return 1;
}

static int write_bytes_accounted_elsewhere(Writer *writer, const void *bytes, uint32_t length) {
  if (length > writer->capacity - writer->length) return PDRV_ABI_CAPACITY;
  if (length != 0u) memcpy(writer->bytes + writer->length, bytes, length);
  writer->length += length;
  return 0;
}

static int write_bytes(Writer *writer, const void *bytes, uint32_t length) {
  if (length > writer->capacity - writer->length) return PDRV_ABI_CAPACITY;
  PDRV_NATIVE_BLOCKS(length);
  return write_bytes_accounted_elsewhere(writer, bytes, length);
}

static int write_u8(Writer *writer, uint8_t value) {
  return write_bytes(writer, &value, 1u);
}

static int write_u32(Writer *writer, uint32_t value) {
  uint8_t bytes[4] = {
    (uint8_t)(value >> 24),
    (uint8_t)(value >> 16),
    (uint8_t)(value >> 8),
    (uint8_t)value,
  };
  return write_bytes(writer, bytes, 4u);
}

static void patch_u32(Writer *writer, uint32_t offset, uint32_t value) {
  writer->bytes[offset] = (uint8_t)(value >> 24);
  writer->bytes[offset + 1u] = (uint8_t)(value >> 16);
  writer->bytes[offset + 2u] = (uint8_t)(value >> 8);
  writer->bytes[offset + 3u] = (uint8_t)value;
}

static int bytes_compare(const uint8_t *left, size_t left_length,
    const uint8_t *right, size_t right_length) {
  size_t shared = left_length < right_length ? left_length : right_length;
  PDRV_NATIVE_BLOCKS(shared);
  int compared = memcmp(left, right, shared);
  if (compared != 0) return compared;
  return left_length < right_length ? -1 : left_length > right_length ? 1 : 0;
}

static int valid_utf8(const uint8_t *bytes, size_t length) {
  size_t offset = 0u;
  while (offset < length) {
    PDRV_NATIVE_ITERATION();
    uint8_t first = bytes[offset++];
    if (first <= 0x7fu) continue;
    if (first >= 0xc2u && first <= 0xdfu) {
      if (offset >= length || (bytes[offset++] & 0xc0u) != 0x80u) return 0;
      continue;
    }
    if (first >= 0xe0u && first <= 0xefu) {
      uint8_t second;
      if (offset + 1u >= length) return 0;
      second = bytes[offset++];
      if ((second & 0xc0u) != 0x80u || (bytes[offset++] & 0xc0u) != 0x80u) return 0;
      if ((first == 0xe0u && second < 0xa0u) || (first == 0xedu && second >= 0xa0u)) return 0;
      continue;
    }
    if (first >= 0xf0u && first <= 0xf4u) {
      uint8_t second;
      if (offset + 2u >= length) return 0;
      second = bytes[offset++];
      if ((second & 0xc0u) != 0x80u
          || (bytes[offset++] & 0xc0u) != 0x80u
          || (bytes[offset++] & 0xc0u) != 0x80u) return 0;
      if ((first == 0xf0u && second < 0x90u) || (first == 0xf4u && second >= 0x90u)) return 0;
      continue;
    }
    return 0;
  }
  return 1;
}

static void new_value(lua_State *state, uint8_t tag) {
  lua_createtable(state, 2, 0);
  lua_pushinteger(state, (lua_Integer)tag);
  lua_rawseti(state, -2, 1);
}

static int encode_value(lua_State *state, int value_index, Writer *writer);
static int decode_value(lua_State *state, Reader *reader);
static int read_name(lua_State *state, Reader *reader);
static int write_name(lua_State *state, int index, Writer *writer);

static int record_key_compare(const void *left_value, const void *right_value) {
  const RecordKey *left = (const RecordKey *)left_value;
  const RecordKey *right = (const RecordKey *)right_value;
  return bytes_compare(
    (const uint8_t *)left->bytes, left->length,
    (const uint8_t *)right->bytes, right->length);
}

static int conversion_enter(ConversionStack *stack, const void *table) {
  size_t index;
  const void **grown;
  for (index = 0u; index < stack->length; index += 1u) {
    PDRV_NATIVE_ITERATION();
    if (stack->tables[index] == table) return PDRV_ENV_CYCLE;
  }
  if (stack->length == stack->capacity) {
    size_t capacity = stack->capacity == 0u ? 8u : stack->capacity * 2u;
    if (capacity < stack->capacity) return PDRV_ABI_CAPACITY;
    grown = (const void **)pdrv_scratch_realloc(stack->tables, capacity * sizeof(*grown));
    if (grown == NULL) return PDRV_ABI_CAPACITY;
    stack->tables = grown;
    stack->capacity = capacity;
  }
  stack->tables[stack->length++] = table;
  return 0;
}

static void conversion_leave(ConversionStack *stack) {
  if (stack->length != 0u) stack->length -= 1u;
}

static AuthoredBoundary *boundary_value(lua_State *state, int index) {
  AuthoredBoundary *boundary;
  if (lua_type(state, index) != LUA_TUSERDATA) return NULL;
  boundary = (AuthoredBoundary *)lua_touserdata(state, index);
  return boundary != NULL && boundary->magic == PDRV_BOUNDARY_MAGIC ? boundary : NULL;
}

#ifdef PDRV_RETAINED_DISPATCH
static void retained_boundary_metatable(lua_State *state);
#endif
static void push_boundary(lua_State *state) {
  AuthoredBoundary *boundary = (AuthoredBoundary *)lua_newuserdatauv(state, sizeof(*boundary), 1);
  boundary->magic = PDRV_BOUNDARY_MAGIC;
  lua_insert(state, -2);
  lua_setiuservalue(state, -2, 1);
#ifdef PDRV_RETAINED_DISPATCH
  retained_boundary_metatable(state);
#endif
}

#ifdef PDRV_RETAINED_DISPATCH
/* A real userdata, not an empty-table proxy: rawset cannot bypass immutability.
 * The only table reference is a private uservalue, unavailable to closed Lua. */
#define PDRV_READONLY_MAGIC UINT32_C(0x50524452)
typedef struct { uint32_t magic; int array; } ReadonlyValue;
static ReadonlyValue *readonly_value(lua_State *state, int index) {
  if (lua_type(state, index) != LUA_TUSERDATA || lua_rawlen(state, index) != sizeof(ReadonlyValue)) return NULL;
  ReadonlyValue *value = (ReadonlyValue *)lua_touserdata(state, index);
  return value->magic == PDRV_READONLY_MAGIC ? value : NULL;
}
static int readonly_index(lua_State *state) {
  lua_getiuservalue(state, 1, 1); lua_pushvalue(state, 2); lua_rawget(state, -2); return 1;
}
static int readonly_length(lua_State *state) {
  lua_getiuservalue(state, 1, 1); lua_pushinteger(state, (lua_Integer)lua_rawlen(state, -1)); return 1;
}
static int readonly_write(lua_State *state) { return luaL_error(state, "immutable argument/facade"); }
static void push_readonly(lua_State *state, int array) {
  ReadonlyValue *value = (ReadonlyValue *)lua_newuserdatauv(state, sizeof(*value), 1);
  value->magic = PDRV_READONLY_MAGIC; value->array = array;
  lua_insert(state, -2); lua_setiuservalue(state, -2, 1);
  lua_createtable(state, 0, 4);
  lua_pushcfunction(state, readonly_index); lua_setfield(state, -2, "__index");
  lua_pushcfunction(state, readonly_length); lua_setfield(state, -2, "__len");
  lua_pushcfunction(state, readonly_write); lua_setfield(state, -2, "__newindex");
  lua_pushboolean(state, 0); lua_setfield(state, -2, "__metatable");
  lua_setmetatable(state, -2);
}
static int pdrv_readonly(lua_State *state) {
  luaL_checktype(state, 1, LUA_TTABLE); lua_settop(state, 1); push_readonly(state, 0); return 1;
}
/* Separately compile the verified entry: it must not share lexical scope with
 * the trusted retained dispatcher. This is not an arbitrary-source load API. */
static int pdrv_retained_entry(lua_State *state) {
  PDRV_NATIVE_ITERATION();
  if (lua_toboolean(state, lua_upvalueindex(2))) return luaL_error(state, "authored.entry.already-loaded");
  lua_pushboolean(state, 1); lua_replace(state, lua_upvalueindex(2));
  const uint8_t name[] = "device.lua";
  int length = pdrv_lua_require_source(name, 10, NULL, 0);
  if (length < 0 || length > 1024 * 1024) return luaL_error(state, "authored.entry.missing-or-large");
  uint8_t *source = (uint8_t *)pdrv_scratch_malloc(length == 0 ? 1u : (size_t)length);
  if (source == NULL) return luaL_error(state, "authored.entry.allocation");
  if (pdrv_lua_require_source(name, 10, source, (uint32_t)length) != length) { pdrv_scratch_free(source); return luaL_error(state, "authored.entry.changed"); }
  lua_settop(state, 0);
  int status = luaL_loadbufferx(state, (const char *)source, (size_t)length, "device.lua", "t");
  pdrv_scratch_free(source);
  if (status != LUA_OK) return lua_error(state);
  lua_pushvalue(state, lua_upvalueindex(1));
  if (lua_setupvalue(state, -2, 1) == NULL) return luaL_error(state, "authored.entry.environment");
  lua_call(state, 0, 2);
  return 2;
}
static int pdrv_array(lua_State *state);
#endif

static int authored_to_tagged(lua_State *state, int value_index, ConversionStack *stack);

static int authored_table_to_record(lua_State *state, int value_index, ConversionStack *stack) {
  int absolute = lua_absindex(state, value_index);
  const void *identity = lua_topointer(state, absolute);
  RecordKey *keys = NULL;
  size_t count = 0u;
  size_t capacity = 0u;
  size_t index;
  int result = conversion_enter(stack, identity);
  if (result != 0) return result;

  lua_pushnil(state);
  while (lua_next(state, absolute) != 0) {
    PDRV_NATIVE_ITERATION();
    size_t key_length;
    const char *key;
    RecordKey *grown;
    lua_pop(state, 1);
    if (lua_type(state, -1) != LUA_TSTRING) { result = PDRV_ENV_RECORD_KEY; break; }
    key = lua_tolstring(state, -1, &key_length);
    if (key == NULL || key_length == 0u || !valid_utf8((const uint8_t *)key, key_length)) {
      result = PDRV_ENV_RECORD_KEY;
      break;
    }
    if (count == capacity) {
      size_t next_capacity = capacity == 0u ? 8u : capacity * 2u;
      if (next_capacity < capacity) { result = PDRV_ABI_CAPACITY; break; }
      grown = (RecordKey *)pdrv_scratch_realloc(keys, next_capacity * sizeof(*grown));
      if (grown == NULL) { result = PDRV_ABI_CAPACITY; break; }
      keys = grown;
      capacity = next_capacity;
    }
    keys[count].bytes = key;
    keys[count].length = key_length;
    count += 1u;
  }
  if (result != 0 && lua_gettop(state) > absolute) lua_pop(state, 1);
  if (result == 0) {
    qsort(keys, count, sizeof(*keys), record_key_compare);
    new_value(state, 0x0au);
    lua_createtable(state, (int)count, 0);
    for (index = 0u; index < count; index += 1u) {
      PDRV_NATIVE_ITERATION();
      lua_createtable(state, 2, 0);
      PDRV_NATIVE_BLOCKS(keys[index].length);
      lua_pushlstring(state, keys[index].bytes, keys[index].length);
      lua_rawseti(state, -2, 1);
      PDRV_NATIVE_BLOCKS(keys[index].length);
      lua_pushlstring(state, keys[index].bytes, keys[index].length);
      lua_rawget(state, absolute);
      result = authored_to_tagged(state, -1, stack);
      lua_remove(state, -2);
      if (result != 0) { lua_pop(state, 2); break; }
      lua_rawseti(state, -2, 2);
      lua_rawseti(state, -2, (lua_Integer)index + 1);
    }
    if (result == 0) lua_rawseti(state, -2, 2);
    else lua_pop(state, 1);
  }
  pdrv_scratch_free(keys);
  conversion_leave(stack);
  return result;
}

static int authored_to_tagged(lua_State *state, int value_index, ConversionStack *stack) {
  PDRV_NATIVE_ITERATION();
#ifdef PDRV_RETAINED_DISPATCH
  if (!lua_checkstack(state, 32)) return PDRV_RESOURCE_ALLOCATION;
#endif
  int absolute = lua_absindex(state, value_index);
  int type = lua_type(state, absolute);
  if (type == LUA_TBOOLEAN) {
    new_value(state, lua_toboolean(state, absolute) ? 0x02u : 0x01u);
    lua_pushboolean(state, lua_toboolean(state, absolute));
    lua_rawseti(state, -2, 2);
    return 0;
  }
  if (type == LUA_TSTRING) {
    size_t length;
    const char *bytes = lua_tolstring(state, absolute, &length);
    if (bytes == NULL || !valid_utf8((const uint8_t *)bytes, length)) return PDRV_ENV_INVALID_TEXT;
    new_value(state, 0x07u);
    lua_pushvalue(state, absolute);
    lua_rawseti(state, -2, 2);
    return 0;
  }
  if (type == LUA_TNUMBER) {
    lua_Number number;
    if (lua_isinteger(state, absolute)) {
      lua_Integer integer = lua_tointeger(state, absolute);
      uint64_t bits = (uint64_t)(int64_t)integer;
      uint8_t bytes[8];
      uint32_t index;
      for (index = 0u; index < 8u; index += 1u) {
        bytes[7u - index] = (uint8_t)(bits & 0xffu);
        bits >>= 8u;
      }
      new_value(state, 0x03u);
      lua_pushlstring(state, (const char *)bytes, sizeof(bytes));
      lua_rawseti(state, -2, 2);
      return 0;
    }
    number = lua_tonumber(state, absolute);
    if (!isfinite((double)number)) return PDRV_ABI_NONFINITE;
    if (number == 0.0 && signbit((double)number)) return PDRV_ABI_NEGATIVE_ZERO;
    new_value(state, 0x06u);
    lua_pushnumber(state, number);
    lua_rawseti(state, -2, 2);
    return 0;
  }
  if (type == LUA_TTABLE) return authored_table_to_record(state, absolute, stack);
  if (type == LUA_TUSERDATA) {
#ifdef PDRV_RETAINED_DISPATCH
    ReadonlyValue *readonly = readonly_value(state, absolute);
    if (readonly != NULL) {
      if (readonly->array) {
        lua_pushcfunction(state, pdrv_array); lua_getiuservalue(state, absolute, 1); lua_call(state, 1, 1);
        lua_getiuservalue(state, -1, 1); lua_remove(state, -2); return 0;
      }
      lua_getiuservalue(state, absolute, 1);
      int result = authored_to_tagged(state, -1, stack);
      lua_remove(state, result == 0 ? -2 : -1); return result;
    }
#endif
    if (boundary_value(state, absolute) == NULL) return PDRV_ENV_BOUNDARY;
    if (lua_getiuservalue(state, absolute, 1) != LUA_TTABLE) { lua_pop(state, 1); return PDRV_ENV_BOUNDARY; }
    return 0;
  }
  if (type == LUA_TNIL) return PDRV_ENV_MISSING_VALUE;
  return PDRV_ENV_BOUNDARY;
}

static int canonical_decimal(lua_State *state, int argument, int allow_negative,
    const char **digits, size_t *digit_count, int *negative) {
  size_t length;
  const char *text;
  size_t index = 0u;
  luaL_argcheck(state, lua_type(state, argument) == LUA_TSTRING, argument,
    "canonical decimal string required");
  text = lua_tolstring(state, argument, &length);
  if (text == NULL || length == 0u) return PDRV_ENV_INTEGER_DECIMAL;
  *negative = text[0] == '-';
  if (*negative) {
    if (!allow_negative || length == 1u) return PDRV_ENV_INTEGER_DECIMAL;
    index = 1u;
  }
  if (text[index] == '0') {
    if (length - index != 1u || *negative) return PDRV_ENV_INTEGER_DECIMAL;
  } else if (text[index] < '1' || text[index] > '9') {
    return PDRV_ENV_INTEGER_DECIMAL;
  }
  for (; index < length; index += 1u) {
    PDRV_NATIVE_ITERATION();
    if (text[index] < '0' || text[index] > '9') return PDRV_ENV_INTEGER_DECIMAL;
  }
  *digits = text + (*negative ? 1u : 0u);
  *digit_count = length - (*negative ? 1u : 0u);
  return 0;
}

static int parse_decimal_u64(const char *digits, size_t digit_count,
    uint64_t maximum, uint64_t *value) {
  size_t index;
  uint64_t parsed = 0u;
  for (index = 0u; index < digit_count; index += 1u) {
    PDRV_NATIVE_ITERATION();
    uint64_t digit = (uint64_t)(digits[index] - '0');
    if (parsed > (maximum - digit) / 10u) return PDRV_ENV_INTEGER_RANGE;
    parsed = parsed * 10u + digit;
  }
  *value = parsed;
  return 0;
}

static int pdrv_fixed_integer(lua_State *state, uint8_t tag, int is_signed) {
  const char *digits;
  size_t digit_count;
  int negative;
  uint64_t magnitude;
  uint64_t maximum;
  uint64_t bits;
  uint8_t bytes[8];
  uint32_t index;
  int result;
  luaL_argcheck(state, lua_gettop(state) == 1, 1, "one canonical decimal string required");
  result = canonical_decimal(state, 1, is_signed, &digits, &digit_count, &negative);
  if (result != 0) return luaL_error(state, "lua-vm.environment.integer-decimal");
  maximum = is_signed
    ? (negative ? UINT64_C(0x8000000000000000) : UINT64_C(0x7fffffffffffffff))
    : UINT64_MAX;
  result = parse_decimal_u64(digits, digit_count, maximum, &magnitude);
  if (result != 0) return luaL_error(state, "lua-vm.environment.integer-range");
  bits = negative ? (uint64_t)(0u - magnitude) : magnitude;
  for (index = 0u; index < 8u; index += 1u) {
    bytes[7u - index] = (uint8_t)(bits & 0xffu);
    bits >>= 8u;
  }
  new_value(state, tag);
  lua_pushlstring(state, (const char *)bytes, sizeof(bytes));
  lua_rawseti(state, -2, 2);
  push_boundary(state);
  return 1;
}

static int pdrv_i64(lua_State *state) {
  return pdrv_fixed_integer(state, 0x03u, 1);
}

static int pdrv_u64(lua_State *state) {
  return pdrv_fixed_integer(state, 0x04u, 0);
}

static int pdrv_integer(lua_State *state) {
  PDRV_NATIVE_ITERATION();
  const char *digits;
  size_t digit_count;
  int negative;
  uint8_t *magnitude;
  size_t magnitude_count = 0u;
  size_t digit_index;
  int result;
  luaL_argcheck(state, lua_gettop(state) == 1, 1, "one canonical decimal string required");
  result = canonical_decimal(state, 1, 1, &digits, &digit_count, &negative);
  if (result != 0) return luaL_error(state, "lua-vm.environment.integer-decimal");
  magnitude = (uint8_t *)pdrv_scratch_calloc(digit_count == 0u ? 1u : digit_count, 1u);
  if (magnitude == NULL) return luaL_error(state, "lua-vm.environment.capacity");
  for (digit_index = 0u; digit_index < digit_count; digit_index += 1u) {
    PDRV_NATIVE_ITERATION();
    uint32_t carry = (uint32_t)(digits[digit_index] - '0');
    size_t byte_index;
    for (byte_index = 0u; byte_index < magnitude_count; byte_index += 1u) {
      PDRV_NATIVE_ITERATION();
      uint32_t next = (uint32_t)magnitude[byte_index] * 10u + carry;
      magnitude[byte_index] = (uint8_t)(next & 0xffu);
      carry = next >> 8u;
    }
    while (carry != 0u) {
      PDRV_NATIVE_ITERATION();
      magnitude[magnitude_count++] = (uint8_t)(carry & 0xffu);
      carry >>= 8u;
    }
  }
  new_value(state, 0x05u);
  luaL_Buffer buffer;
  char *payload = luaL_buffinitsize(state, &buffer, 1u + magnitude_count);
  payload[0] = negative ? 1 : 0;
  for (digit_index = 0u; digit_index < magnitude_count; digit_index += 1u) {
    PDRV_NATIVE_ITERATION();
    payload[1u + digit_index] = (char)magnitude[magnitude_count - digit_index - 1u];
  }
  pdrv_scratch_free(magnitude);
  luaL_pushresultsize(&buffer, 1u + magnitude_count);
  lua_rawseti(state, -2, 2);
  push_boundary(state);
  return 1;
}

static int pdrv_variant(lua_State *state) {
  PDRV_NATIVE_ITERATION();
  size_t tag_length;
  const char *tag;
  ConversionStack stack = { NULL, 0u, 0u };
  int result;
  luaL_argcheck(state, lua_gettop(state) == 2, 1, "tag and value required");
  luaL_argcheck(state, lua_type(state, 1) == LUA_TSTRING, 1, "string tag required");
  tag = lua_tolstring(state, 1, &tag_length);
  if (tag == NULL || tag_length == 0u || !valid_utf8((const uint8_t *)tag, tag_length)) {
    return luaL_error(state, "lua-vm.environment.variant-tag");
  }
  result = authored_to_tagged(state, 2, &stack);
  pdrv_scratch_free(stack.tables);
  if (result != 0) return luaL_error(state, "lua-vm.environment.variant-value");
  new_value(state, 0x0bu);
  lua_createtable(state, 2, 0);
  PDRV_NATIVE_BLOCKS(tag_length);
  lua_pushlstring(state, tag, tag_length);
  lua_rawseti(state, -2, 1);
  lua_pushvalue(state, -3);
  lua_rawseti(state, -2, 2);
  lua_rawseti(state, -2, 2);
  lua_remove(state, -2);
  push_boundary(state);
  return 1;
}

static int pdrv_bytes(lua_State *state) {
  PDRV_NATIVE_ITERATION();
  size_t length;
  const char *bytes;
  luaL_argcheck(state, lua_type(state, 1) == LUA_TSTRING, 1, "string required");
  luaL_argcheck(state, lua_gettop(state) == 1, 1, "one string required");
  bytes = lua_tolstring(state, 1, &length);
  new_value(state, 0x08u);
  PDRV_NATIVE_BLOCKS(length);
  lua_pushlstring(state, bytes, length);
  lua_rawseti(state, -2, 2);
  push_boundary(state);
  return 1;
}

static int pdrv_array(lua_State *state) {
  PDRV_NATIVE_ITERATION();
  int source = 1;
  lua_Integer maximum = 0;
  size_t count = 0u;
  lua_Integer index;
  ConversionStack stack = { NULL, 0u, 0u };
  int result;
  luaL_checktype(state, source, LUA_TTABLE);
  luaL_argcheck(state, lua_gettop(state) == 1, 1, "one table required");
  lua_pushnil(state);
  while (lua_next(state, source) != 0) {
    PDRV_NATIVE_ITERATION();
    lua_Integer key;
    lua_pop(state, 1);
    if (!lua_isinteger(state, -1) || (key = lua_tointeger(state, -1)) <= 0) {
      pdrv_scratch_free(stack.tables);
      return luaL_error(state, "lua-vm.environment.array-shape");
    }
    if (key > maximum) maximum = key;
    count += 1u;
  }
  if ((lua_Unsigned)maximum != (lua_Unsigned)count || count > (size_t)INT32_MAX) {
    pdrv_scratch_free(stack.tables);
    return luaL_error(state, "lua-vm.environment.array-shape");
  }
  result = conversion_enter(&stack, lua_topointer(state, source));
  if (result != 0) { pdrv_scratch_free(stack.tables); return luaL_error(state, "lua-vm.environment.array-cycle"); }
  new_value(state, 0x09u);
  lua_createtable(state, (int)count, 0);
  for (index = 1; index <= maximum; index += 1) {
    PDRV_NATIVE_ITERATION();
    lua_rawgeti(state, source, index);
    if (lua_isnil(state, -1)) result = PDRV_ENV_ARRAY_SHAPE;
    else result = authored_to_tagged(state, -1, &stack);
    lua_remove(state, -2);
    if (result != 0) { lua_pop(state, 2); break; }
    lua_rawseti(state, -2, index);
  }
  conversion_leave(&stack);
  pdrv_scratch_free(stack.tables);
  if (result != 0) return luaL_error(state,
    result == PDRV_ENV_CYCLE ? "lua-vm.environment.array-cycle" : "lua-vm.environment.array-value");
  lua_rawseti(state, -2, 2);
  push_boundary(state);
  return 1;
}

static int pdrv_record_fields_next(lua_State *state) {
  lua_Integer index = lua_tointeger(state, lua_upvalueindex(2)) + 1;
  lua_pushinteger(state, index);
  lua_replace(state, lua_upvalueindex(2));
  lua_rawgeti(state, lua_upvalueindex(1), index);
  if (lua_isnil(state, -1)) return 0;
  lua_rawgeti(state, -1, 1);
  lua_rawgeti(state, -2, 2);
  return 2;
}

static int pdrv_record_fields(lua_State *state) {
  PDRV_NATIVE_ITERATION();
  int source = 1;
  RecordKey *keys = NULL;
  size_t count = 0u;
  size_t capacity = 0u;
  size_t index;
#ifdef PDRV_RETAINED_DISPATCH
  luaL_argcheck(state, lua_gettop(state) == 1, 1, "one record required");
  if (readonly_value(state, source) != NULL) { lua_getiuservalue(state, source, 1); lua_replace(state, source); }
  luaL_checktype(state, source, LUA_TTABLE);
#else
  luaL_checktype(state, source, LUA_TTABLE);
  luaL_argcheck(state, lua_gettop(state) == 1, 1, "one record required");
#endif
  lua_pushnil(state);
  while (lua_next(state, source) != 0) {
    PDRV_NATIVE_ITERATION();
    size_t key_length;
    const char *key;
    RecordKey *grown;
    lua_pop(state, 1);
    if (lua_type(state, -1) != LUA_TSTRING) { pdrv_scratch_free(keys); return luaL_error(state, "lua-vm.environment.record-key"); }
    key = lua_tolstring(state, -1, &key_length);
    if (key == NULL || key_length == 0u || !valid_utf8((const uint8_t *)key, key_length)) {
      pdrv_scratch_free(keys); return luaL_error(state, "lua-vm.environment.record-key");
    }
    if (count == capacity) {
      size_t next_capacity = capacity == 0u ? 8u : capacity * 2u;
      grown = (RecordKey *)pdrv_scratch_realloc(keys, next_capacity * sizeof(*grown));
      if (grown == NULL) { pdrv_scratch_free(keys); return luaL_error(state, "lua-vm.environment.capacity"); }
      keys = grown;
      capacity = next_capacity;
    }
    keys[count].bytes = key;
    keys[count].length = key_length;
    count += 1u;
  }
  qsort(keys, count, sizeof(*keys), record_key_compare);
  lua_createtable(state, (int)count, 0);
  for (index = 0u; index < count; index += 1u) {
    PDRV_NATIVE_ITERATION();
    lua_createtable(state, 2, 0);
    PDRV_NATIVE_BLOCKS(keys[index].length);
    lua_pushlstring(state, keys[index].bytes, keys[index].length);
    lua_rawseti(state, -2, 1);
    PDRV_NATIVE_BLOCKS(keys[index].length);
    lua_pushlstring(state, keys[index].bytes, keys[index].length);
    lua_rawget(state, source);
    lua_rawseti(state, -2, 2);
    lua_rawseti(state, -2, (lua_Integer)index + 1);
  }
  pdrv_scratch_free(keys);
  lua_pushinteger(state, 0);
  lua_pushcclosure(state, pdrv_record_fields_next, 2);
  return 1;
}

static int pdrv_fail(lua_State *state) {
  size_t name_length;
  const char *name;
  ConversionStack stack = { NULL, 0u, 0u };
  NamedFailure *failure;
  int result;
  luaL_argcheck(state, lua_type(state, 1) == LUA_TSTRING, 1, "string name required");
  luaL_argcheck(state, lua_gettop(state) == 2, 1, "name and details required");
  name = lua_tolstring(state, 1, &name_length);
  if (name_length == 0u || !valid_utf8((const uint8_t *)name, name_length)) {
    return luaL_error(state, "lua-vm.environment.failure-name");
  }
  result = authored_to_tagged(state, 2, &stack);
  pdrv_scratch_free(stack.tables);
  if (result != 0) return luaL_error(state, "lua-vm.environment.failure-details");
  failure = (NamedFailure *)lua_newuserdatauv(state, sizeof(*failure), 2);
  failure->magic = PDRV_FAILURE_MAGIC;
  PDRV_NATIVE_BLOCKS(name_length);
  lua_pushlstring(state, name, name_length);
  lua_setiuservalue(state, -2, 1);
  lua_pushvalue(state, -2);
  lua_setiuservalue(state, -2, 2);
  return lua_error(state);
}

static void set_loading(lua_State *state, int name, int loading) {
  lua_pushvalue(state, name);
  if (loading) lua_pushboolean(state, 1);
  else lua_pushnil(state);
  lua_rawset(state, lua_upvalueindex(2));
}

static int pdrv_require(lua_State *state) {
  PDRV_NATIVE_ITERATION();
  size_t length;
  const char *name;
  int32_t source_length;
  uint8_t *source;
  int call_status;
  luaL_argcheck(state, lua_type(state, 1) == LUA_TSTRING, 1, "string module name required");
  luaL_argcheck(state, lua_gettop(state) == 1, 1, "one module name required");
  name = lua_tolstring(state, 1, &length);
  if (length == 0u || length > UINT32_MAX || !valid_utf8((const uint8_t *)name, length)) {
    return luaL_error(state, "lua-vm.require.name-invalid");
  }

  lua_pushvalue(state, 1);
  lua_rawget(state, lua_upvalueindex(1));
  if (!lua_isnil(state, -1)) {
    lua_rawgeti(state, -1, 1);
    return 1;
  }
  lua_pop(state, 1);

  lua_pushvalue(state, 1);
  lua_rawget(state, lua_upvalueindex(2));
  if (!lua_isnil(state, -1)) {
    return luaL_error(state, "lua-vm.require.initialization-cycle: %s", name);
  }
  lua_pop(state, 1);

  source_length = pdrv_lua_require_source(
    (const uint8_t *)name, (uint32_t)length, NULL, 0u);
  if (source_length < 0) return luaL_error(state, "lua-vm.require.missing: %s", name);
  source = (uint8_t *)pdrv_scratch_malloc(source_length == 0 ? 1u : (size_t)source_length);
  if (source == NULL) return luaL_error(state, "lua-vm.environment.capacity");
  if (pdrv_lua_require_source(
      (const uint8_t *)name, (uint32_t)length,
      source, (uint32_t)source_length) != source_length) {
    pdrv_scratch_free(source);
    return luaL_error(state, "lua-vm.require.missing: %s", name);
  }

  set_loading(state, 1, 1);
  call_status = luaL_loadbufferx(state, (const char *)source, (size_t)source_length, name, "t");
  pdrv_scratch_free(source);
  if (call_status == LUA_OK) {
    lua_pushvalue(state, lua_upvalueindex(3));
    if (lua_setupvalue(state, -2, 1) == NULL) {
      lua_pop(state, 1);
      call_status = LUA_ERRSYNTAX;
      lua_pushliteral(state, "lua-vm.require.source-environment");
    } else {
      call_status = lua_pcall(state, 0, 1, 0);
    }
  }
  set_loading(state, 1, 0);
  if (call_status != LUA_OK) return lua_error(state);

  lua_createtable(state, 1, 0);
  lua_pushvalue(state, -2);
  lua_rawseti(state, -2, 1);
  lua_pushvalue(state, 1);
  lua_pushvalue(state, -2);
  lua_rawset(state, lua_upvalueindex(1));
  lua_pop(state, 1);
  return 1;
}

static void copy_field(lua_State *state, int source, int target, const char *name) {
  lua_getfield(state, source, name);
  lua_setfield(state, target, name);
}

static void copy_fields(lua_State *state, int source, int target,
    const char *const *names) {
  const char *const *name;
  for (name = names; *name != NULL; name += 1) copy_field(state, source, target, *name);
}

static int has_pointer_free_text(lua_State *state, int index) {
  int type = lua_type(state, index);
  if (type == LUA_TNIL || type == LUA_TBOOLEAN || type == LUA_TNUMBER
      || type == LUA_TSTRING) return 1;
  if (luaL_getmetafield(state, index, "__tostring") != LUA_TNIL) {
    lua_pop(state, 1);
    return 1;
  }
  return 0;
}

static int pointer_rendering_error(lua_State *state) {
  return luaL_error(state, "lua-vm.environment.pointer-rendering");
}

static int restricted_tostring(lua_State *state) {
  luaL_checkany(state, 1);
  if (!has_pointer_free_text(state, 1)) return pointer_rendering_error(state);
  luaL_tolstring(state, 1, NULL);
  return 1;
}

static int restricted_string_format(lua_State *state) {
  int top = lua_gettop(state);
  int argument = 1;
  size_t length;
  size_t index;
  const char *format = luaL_checklstring(state, 1, &length);
  for (index = 0u; index < length; index += 1u) {
    PDRV_NATIVE_ITERATION();
    unsigned char specifier;
    if (format[index] != '%') continue;
    index += 1u;
    if (index >= length || format[index] == '%') continue;
    argument += 1;
    while (index < length && strchr("-+ #0", format[index]) != NULL) { PDRV_NATIVE_ITERATION(); index += 1u; }
    while (index < length && format[index] >= '0' && format[index] <= '9') { PDRV_NATIVE_ITERATION(); index += 1u; }
    if (index < length && format[index] == '.') {
      index += 1u;
      while (index < length && format[index] >= '0' && format[index] <= '9') { PDRV_NATIVE_ITERATION(); index += 1u; }
    }
    if (index >= length) continue;
    specifier = (unsigned char)format[index];
    if (specifier == 'p') return pointer_rendering_error(state);
    if (specifier == 's' && argument <= top
        && !has_pointer_free_text(state, argument)) {
      return pointer_rendering_error(state);
    }
  }
  lua_pushvalue(state, lua_upvalueindex(1));
  lua_insert(state, 1);
  lua_call(state, top, LUA_MULTRET);
  return lua_gettop(state);
}

static int build_closed_environment(lua_State *state) {
  int base;
  int coroutine_library;
  int math_library;
  int string_library;
  int table_library;
  int utf8_library;
  int environment;
  int pdrv;
  int restricted_coroutine;
  int restricted_math;
  int restricted_string;
  int restricted_table;
  int restricted_utf8;
  static const char *const base_names[] = {
    "_VERSION", "assert", "collectgarbage", "error", "getmetatable", "ipairs",
    "pcall", "rawequal", "rawget", "rawlen", "rawset", "select", "setmetatable",
    "tonumber", "type", "xpcall", NULL
  };
  static const char *const coroutine_names[] = {
    "close", "create", "isyieldable", "resume", "running", "status", "wrap", "yield", NULL
  };
  static const char *const math_names[] = {
    "abs", "acos", "asin", "atan", "ceil", "cos", "deg", "exp", "floor", "fmod",
    "frexp", "huge", "ldexp", "log", "max", "maxinteger", "min", "mininteger",
    "modf", "pi", "rad", "sin", "sqrt", "tan", "tointeger", "type", "ult", NULL
  };
  static const char *const string_names[] = {
    "byte", "char", "dump", "find", "gmatch", "gsub", "len", "lower", "match",
    "pack", "packsize", "rep", "reverse", "sub", "unpack", "upper", NULL
  };
  static const char *const table_names[] = {
    "concat", "create", "insert", "move", "pack", "remove", "sort", "unpack", NULL
  };
  static const char *const utf8_names[] = {
    "char", "charpattern", "codepoint", "codes", "len", "offset", NULL
  };

  luaopen_base(state);
  base = lua_absindex(state, -1);
  luaopen_coroutine(state);
  coroutine_library = lua_absindex(state, -1);
  luaopen_math(state);
  math_library = lua_absindex(state, -1);
  luaopen_string(state);
  string_library = lua_absindex(state, -1);
  luaopen_table(state);
  table_library = lua_absindex(state, -1);
  luaopen_utf8(state);
  utf8_library = lua_absindex(state, -1);

  lua_createtable(state, 0, 25);
  environment = lua_absindex(state, -1);
  copy_fields(state, base, environment, base_names);
  lua_pushcfunction(state, restricted_tostring);
  lua_setfield(state, environment, "tostring");
  lua_createtable(state, 0, 0);
  lua_createtable(state, 0, 0);
  lua_pushvalue(state, environment);
  lua_pushcclosure(state, pdrv_require, 3);
  lua_setfield(state, environment, "require");

  lua_createtable(state, 0, 9);
  pdrv = lua_absindex(state, -1);
#ifdef PDRV_RETAINED_DISPATCH
  lua_pushcfunction(state, pdrv_readonly);
  lua_setfield(state, pdrv, "readonly");
  lua_pushvalue(state, environment); lua_pushboolean(state, 0);
  lua_pushcclosure(state, pdrv_retained_entry, 2);
  lua_setfield(state, pdrv, "entry");
#endif
  lua_pushcfunction(state, pdrv_array);
  lua_setfield(state, pdrv, "array");
  lua_pushcfunction(state, pdrv_bytes);
  lua_setfield(state, pdrv, "bytes");
  lua_pushcfunction(state, pdrv_fail);
  lua_setfield(state, pdrv, "fail");
  lua_pushcfunction(state, pdrv_i64);
  lua_setfield(state, pdrv, "i64");
  lua_pushcfunction(state, pdrv_integer);
  lua_setfield(state, pdrv, "integer");
  lua_pushcfunction(state, pdrv_record_fields);
  lua_setfield(state, pdrv, "record_fields");
  new_value(state, 0x0cu);
  push_boundary(state);
  lua_setfield(state, pdrv, "null");
  lua_pushcfunction(state, pdrv_u64);
  lua_setfield(state, pdrv, "u64");
  lua_pushcfunction(state, pdrv_variant);
  lua_setfield(state, pdrv, "variant");
  lua_setfield(state, environment, "pdrv");

  lua_createtable(state, 0, 8);
  restricted_coroutine = lua_absindex(state, -1);
  copy_fields(state, coroutine_library, restricted_coroutine, coroutine_names);
  lua_setfield(state, environment, "coroutine");

  lua_createtable(state, 0, 27);
  restricted_math = lua_absindex(state, -1);
  copy_fields(state, math_library, restricted_math, math_names);
  lua_setfield(state, environment, "math");

  lua_createtable(state, 0, 17);
  restricted_string = lua_absindex(state, -1);
  copy_fields(state, string_library, restricted_string, string_names);
  lua_getfield(state, string_library, "format");
  lua_pushcclosure(state, restricted_string_format, 1);
  lua_setfield(state, restricted_string, "format");
  lua_pushliteral(state, "");
  if (lua_getmetatable(state, -1)) {
    lua_pushvalue(state, restricted_string);
    lua_setfield(state, -2, "__index");
    lua_pop(state, 1);
  }
  lua_pop(state, 1);
  lua_setfield(state, environment, "string");

  lua_createtable(state, 0, 8);
  restricted_table = lua_absindex(state, -1);
  copy_fields(state, table_library, restricted_table, table_names);
  lua_setfield(state, environment, "table");

  lua_createtable(state, 0, 6);
  restricted_utf8 = lua_absindex(state, -1);
  copy_fields(state, utf8_library, restricted_utf8, utf8_names);
  lua_setfield(state, environment, "utf8");

  lua_pushvalue(state, environment);
  lua_setfield(state, environment, "_G");

  lua_pushvalue(state, environment);
  lua_replace(state, 1);
  lua_settop(state, 1);
  return 0;
}

static int authority_true(lua_State *state) {
  lua_pushboolean(state, 1);
  return 1;
}

static void inject_member_function(lua_State *state, int environment,
    const char *table_name, const char *member_name) {
  lua_createtable(state, 0, 1);
  lua_pushcfunction(state, authority_true);
  lua_setfield(state, -2, member_name);
  lua_setfield(state, environment, table_name);
}

static int inject_test_authority(lua_State *state, int environment, uint32_t channel) {
  int global;
  if (channel == 0u) return 0;
  if (channel == 1u) inject_member_function(state, environment, "os", "clock");
  else if (channel == 2u) inject_member_function(state, environment, "math", "random");
  else if (channel == 3u || channel == 4u) {
    lua_pushglobaltable(state);
    global = lua_absindex(state, -1);
    copy_field(state, global, environment, channel == 3u ? "next" : "tostring");
    lua_pop(state, 1);
  } else if (channel == 5u) inject_member_function(state, environment, "os", "setlocale");
  else if (channel == 6u) inject_member_function(state, environment, "os", "getenv");
  else if (channel == 7u) inject_member_function(state, environment, "document", "render");
  else if (channel == 8u) inject_member_function(state, environment, "cli", "render");
  else if (channel == 9u) inject_member_function(state, environment, "control_model", "construct");
  else if (channel == 10u) inject_member_function(state, environment, "host", "read");
  else return PDRV_ABI_MALFORMED;
  return 0;
}

static int program_error_code(lua_State *state) {
  size_t length;
  const char *message = lua_tolstring(state, -1, &length);
  if (message != NULL) PDRV_NATIVE_BLOCKS(length * 12u);
  if (message == NULL) return PDRV_ENV_PROGRAM;
  if (strstr(message, "lua-vm.environment.array-shape") != NULL) return PDRV_ENV_ARRAY_SHAPE;
  if (strstr(message, "lua-vm.environment.array-cycle") != NULL) return PDRV_ENV_CYCLE;
  if (strstr(message, "lua-vm.environment.record-key") != NULL) return PDRV_ENV_RECORD_KEY;
  if (strstr(message, "lua-vm.environment.array-value") != NULL) return PDRV_ENV_BOUNDARY;
  if (strstr(message, "lua-vm.require.missing") != NULL) return PDRV_REQUIRE_MISSING;
  if (strstr(message, "lua-vm.require.initialization-cycle") != NULL) return PDRV_REQUIRE_INITIALIZATION_CYCLE;
  if (strstr(message, "lua-vm.environment.pointer-rendering") != NULL) return PDRV_ENV_POINTER_RENDERING;
  if (strstr(message, "lua-vm.environment.integer-decimal") != NULL) return PDRV_ENV_INTEGER_DECIMAL;
  if (strstr(message, "lua-vm.environment.integer-range") != NULL) return PDRV_ENV_INTEGER_RANGE;
  if (strstr(message, "lua-vm.environment.variant-tag") != NULL) return PDRV_ENV_VARIANT_TAG;
  if (strstr(message, "lua-vm.environment.variant-value") != NULL) return PDRV_ENV_VARIANT_VALUE;
  return PDRV_ENV_PROGRAM;
}

static void *bounded_lua_allocator(void *user_data, void *pointer, size_t old_size, size_t new_size) {
  ExecutionLimits *limits = (ExecutionLimits *)user_data;
  uint64_t retained = pointer == NULL ? 0u : (uint64_t)old_size;
  uint64_t next;
  void *result;
  if (new_size == 0u) {
    free(pointer);
    limits->allocation_current -= retained;
    return NULL;
  }
  if (limits->allocation_current < retained) {
    limits->allocation_exhausted = 1;
    return NULL;
  }
  next = limits->allocation_current - retained;
  if ((uint64_t)new_size > limits->allocation_limit - next) {
    limits->allocation_exhausted = 1;
    return NULL;
  }
  result = realloc(pointer, new_size);
  if (result == NULL) {
    limits->allocation_exhausted = 1;
    return NULL;
  }
  limits->allocation_current = next + (uint64_t)new_size;
  return result;
}

static void charge_instruction(lua_State *state, lua_Debug *debug) {
  ExecutionLimits *limits;
  (void)debug;
  (void)lua_getallocf(state, (void **)&limits);
  if (limits->fuel_used >= limits->fuel_limit) {
    limits->fuel_exhausted = 1;
    luaL_error(state, "lua-vm.resource.fuel-exhausted");
    return;
  }
  limits->fuel_used += 1u;
#ifdef PDRV_RETAINED_ACCOUNTING
  if (retained_fuel_sink) *retained_fuel_sink = limits->fuel_used;
#endif
}

static int resource_failure(const ExecutionLimits *limits, int call_status) {
  if (limits->fuel_exhausted) return PDRV_RESOURCE_FUEL;
  if (limits->allocation_exhausted || call_status == LUA_ERRMEM) {
    return PDRV_RESOURCE_ALLOCATION;
  }
  return 0;
}

static int encode_admission_result(lua_State *state, int graph_index,
    int exports_index, Writer *writer, ConversionStack *stack,
    uint32_t *payload_start) {
  int graph = lua_absindex(state, graph_index);
  int exports = lua_absindex(state, exports_index);
  RecordKey *keys = NULL;
  size_t count = 0u;
  size_t capacity = 0u;
  size_t index;
  int result = 0;

  if (!lua_istable(state, exports)) return PDRV_ENV_ADMISSION_EXPORTS;
  lua_pushnil(state);
  while (lua_next(state, exports) != 0) {
    PDRV_NATIVE_ITERATION();
    size_t key_length;
    const char *key;
    RecordKey *grown;
    if (lua_type(state, -2) != LUA_TSTRING || !lua_isfunction(state, -1)) {
      result = PDRV_ENV_ADMISSION_EXPORTS;
      lua_pop(state, 2);
      break;
    }
    key = lua_tolstring(state, -2, &key_length);
    if (key == NULL || key_length == 0u
        || !valid_utf8((const uint8_t *)key, key_length)) {
      result = PDRV_ENV_ADMISSION_EXPORTS;
      lua_pop(state, 2);
      break;
    }
    if (count == capacity) {
      size_t next_capacity = capacity == 0u ? 8u : capacity * 2u;
      if (next_capacity < capacity) {
        result = PDRV_ABI_CAPACITY;
        lua_pop(state, 2);
        break;
      }
      grown = (RecordKey *)pdrv_scratch_realloc(keys, next_capacity * sizeof(*grown));
      if (grown == NULL) {
        result = PDRV_ABI_CAPACITY;
        lua_pop(state, 2);
        break;
      }
      keys = grown;
      capacity = next_capacity;
    }
    keys[count].bytes = key;
    keys[count].length = key_length;
    count += 1u;
    lua_pop(state, 1);
  }
  if (result == 0 && count > UINT32_MAX) result = PDRV_ABI_CAPACITY;
  if (result == 0) qsort(keys, count, sizeof(*keys), record_key_compare);
  if (result == 0) result = authored_to_tagged(state, graph, stack);
  if (result == 0) result = write_bytes(writer, "PDRV", 4u);
  if (result == 0) result = write_u8(writer, 1u);
  if (result == 0) result = write_u8(writer, 0x02u);
  if (result == 0) result = write_u32(writer, 0u);
  if (result == 0) *payload_start = writer->length;
  if (result == 0) result = encode_value(state, -1, writer);
  if (result == 0) result = write_u32(writer, (uint32_t)count);
  for (index = 0u; result == 0 && index < count; index += 1u) {
    PDRV_NATIVE_ITERATION();
    result = write_u32(writer, (uint32_t)keys[index].length);
    if (result == 0) result = write_bytes(
      writer, keys[index].bytes, (uint32_t)keys[index].length);
  }
  pdrv_scratch_free(keys);
  return result;
}

static int decoded_invocation_scalar(lua_State *state, int value_index) {
  int absolute = lua_absindex(state, value_index);
  lua_Integer tag;
  lua_rawgeti(state, absolute, 1);
  if (!lua_isinteger(state, -1)) { lua_pop(state, 1); return PDRV_ABI_MALFORMED; }
  tag = lua_tointeger(state, -1);
  lua_pop(state, 1);
  lua_rawgeti(state, absolute, 2);
  if (tag == 0x01 || tag == 0x02) {
    if (!lua_isboolean(state, -1)) { lua_pop(state, 1); return PDRV_ABI_MALFORMED; }
    return 0;
  }
  if (tag == 0x03) {
    size_t length;
    const uint8_t *bytes = (const uint8_t *)lua_tolstring(state, -1, &length);
    uint64_t bits = 0u;
    uint32_t index;
    if (bytes == NULL || length != 8u) { lua_pop(state, 1); return PDRV_ABI_MALFORMED; }
    for (index = 0u; index < 8u; index += 1u) bits = (bits << 8) | bytes[index];
    lua_pop(state, 1);
    lua_pushinteger(state, (lua_Integer)(int64_t)bits);
    return 0;
  }
  if (tag == 0x07 || tag == 0x08) {
    if (lua_type(state, -1) != LUA_TSTRING) { lua_pop(state, 1); return PDRV_ABI_MALFORMED; }
    return 0;
  }
  lua_pop(state, 1);
  return PDRV_ABI_FORBIDDEN;
}

static int decoded_invocation_record(lua_State *state, int value_index) {
  PDRV_NATIVE_ITERATION();
  int absolute = lua_absindex(state, value_index);
  lua_Integer tag;
  size_t count;
  size_t index;
  lua_rawgeti(state, absolute, 1);
  if (!lua_isinteger(state, -1)) { lua_pop(state, 1); return PDRV_ABI_MALFORMED; }
  tag = lua_tointeger(state, -1);
  lua_pop(state, 1);
  if (tag != 0x0a) return PDRV_ABI_FORBIDDEN;
  lua_rawgeti(state, absolute, 2);
  if (!lua_istable(state, -1)) { lua_pop(state, 1); return PDRV_ABI_MALFORMED; }
  count = lua_rawlen(state, -1);
  lua_createtable(state, 0, (int)count);
  for (index = 1u; index <= count; index += 1u) {
    PDRV_NATIVE_ITERATION();
    int result;
    lua_rawgeti(state, -2, (lua_Integer)index);
    if (!lua_istable(state, -1) || lua_rawlen(state, -1) != 2u) {
      lua_pop(state, 3);
      return PDRV_ABI_MALFORMED;
    }
    lua_rawgeti(state, -1, 1);
    lua_rawgeti(state, -2, 2);
    result = decoded_invocation_scalar(state, -1);
    lua_remove(state, -2);
    if (result != 0) { lua_pop(state, 4); return result; }
    lua_remove(state, -3);
    lua_rawset(state, -3);
  }
  lua_remove(state, -2);
  return 0;
}

static int decoded_invocation_bytes_array(lua_State *state, int value_index) {
  PDRV_NATIVE_ITERATION();
  int absolute = lua_absindex(state, value_index);
  lua_Integer tag;
  size_t count;
  size_t index;
  lua_rawgeti(state, absolute, 1);
  if (!lua_isinteger(state, -1)) { lua_pop(state, 1); return PDRV_ABI_MALFORMED; }
  tag = lua_tointeger(state, -1);
  lua_pop(state, 1);
  if (tag != 0x09) return PDRV_ABI_FORBIDDEN;
  lua_rawgeti(state, absolute, 2);
  if (!lua_istable(state, -1)) { lua_pop(state, 1); return PDRV_ABI_MALFORMED; }
  count = lua_rawlen(state, -1);
  lua_createtable(state, (int)count, 0);
  for (index = 1u; index <= count; index += 1u) {
    PDRV_NATIVE_ITERATION();
    int result;
    lua_Integer member_tag;
    lua_rawgeti(state, -2, (lua_Integer)index);
    if (!lua_istable(state, -1)) { lua_pop(state, 3); return PDRV_ABI_MALFORMED; }
    lua_rawgeti(state, -1, 1);
    if (!lua_isinteger(state, -1)) { lua_pop(state, 4); return PDRV_ABI_MALFORMED; }
    member_tag = lua_tointeger(state, -1);
    lua_pop(state, 1);
    if (member_tag != 0x08) { lua_pop(state, 3); return PDRV_ABI_FORBIDDEN; }
    result = decoded_invocation_scalar(state, -1);
    if (result != 0) { lua_pop(state, 3); return result; }
    lua_remove(state, -2);
    lua_rawseti(state, -2, (lua_Integer)index);
  }
  lua_remove(state, -2);
  return 0;
}

#ifdef PDRV_RETAINED_DISPATCH
static int decoded_retained_value(lua_State *state, int value_index);
#endif
static int decoded_invocation_input(lua_State *state, int value_index) {
#ifdef PDRV_RETAINED_DISPATCH
  return decoded_retained_value(state, value_index);
#else
  int absolute = lua_absindex(state, value_index);
  lua_Integer tag;
  lua_rawgeti(state, absolute, 1);
  if (!lua_isinteger(state, -1)) { lua_pop(state, 1); return PDRV_ABI_MALFORMED; }
  tag = lua_tointeger(state, -1);
  lua_pop(state, 1);
  if (tag == 0x0a) return decoded_invocation_record(state, absolute);
  if (tag == 0x09) return decoded_invocation_bytes_array(state, absolute);
  if (tag == 0x08) return decoded_invocation_scalar(state, absolute);
  return PDRV_ABI_FORBIDDEN;
#endif
}

static int decode_program_invocation(lua_State *state,
    const uint8_t *input, uint32_t input_length) {
  Reader reader = { input, input + input_length };
  uint8_t magic[4];
  uint8_t version;
  uint8_t kind;
  uint32_t payload_length;
  uint32_t index;
  int result;
  for (index = 0u; index < 4u; index += 1u) {
    if (!read_u8(&reader, &magic[index])) return PDRV_ABI_MALFORMED;
  }
  if (memcmp(magic, "PDRV", 4u) != 0 || !read_u8(&reader, &version) || version != 1u
      || !read_u8(&reader, &kind) || kind != 0x03u
      || !read_u32(&reader, &payload_length)
      || payload_length != (uint32_t)(reader.end - reader.cursor)) return PDRV_ABI_MALFORMED;
  result = read_name(state, &reader);
  if (result != 0) return result;
  result = decode_value(state, &reader);
  if (result != 0 || reader.cursor != reader.end) return PDRV_ABI_MALFORMED;
  result = decoded_invocation_input(state, -1);
  lua_remove(state, -2);
  return result;
}

static int encode_invocation_outcome(lua_State *state, int call_status,
    Writer *writer, uint32_t *payload_start, ExecutionLimits *limits) {
  NamedFailure *failure;
  ConversionStack stack = { NULL, 0u, 0u };
  int result = resource_failure(limits, call_status);
  if (result != 0) return result;
  if (call_status != LUA_OK) {
    failure = lua_type(state, -1) == LUA_TUSERDATA
      ? (NamedFailure *)lua_touserdata(state, -1) : NULL;
    if (failure == NULL || failure->magic != PDRV_FAILURE_MAGIC) return program_error_code(state);
    result = write_bytes(writer, "PDRV", 4u);
    if (result == 0) result = write_u8(writer, 1u);
    if (result == 0) result = write_u8(writer, 0x04u);
    if (result == 0) result = write_u32(writer, 0u);
    *payload_start = writer->length;
    if (result == 0 && lua_getiuservalue(state, -1, 1) == LUA_TSTRING) {
      result = write_name(state, -1, writer);
      lua_pop(state, 1);
    } else if (result == 0) {
      lua_pop(state, 1);
      result = PDRV_ENV_PROGRAM;
    }
    if (result == 0 && lua_getiuservalue(state, -1, 2) == LUA_TTABLE) {
      result = encode_value(state, -1, writer);
      lua_pop(state, 1);
    } else if (result == 0) {
      lua_pop(state, 1);
      result = PDRV_ENV_PROGRAM;
    }
  } else {
    result = authored_to_tagged(state, -1, &stack);
    if (result == 0) {
      result = write_bytes(writer, "PDRV", 4u);
      if (result == 0) result = write_u8(writer, 1u);
      if (result == 0) result = write_u8(writer, 0x01u);
      if (result == 0) result = write_u32(writer, 0u);
      *payload_start = writer->length;
      if (result == 0) result = encode_value(state, -1, writer);
    }
  }
  pdrv_scratch_free(stack.tables);
  return result;
}

static int execute_closed_source(const uint8_t *source, uint32_t source_length,
    uint8_t *output, uint32_t output_capacity, uint32_t channel,
    uint32_t allocation_limit, uint32_t fuel_limit, uint32_t *fuel_used,
    int admission) {
  ExecutionLimits limits = { 0u, allocation_limit, 0u, fuel_limit, 0, 0 };
  lua_State *state = lua_newstate(bounded_lua_allocator, &limits, 0x50445256u);
  Writer writer = { output, 0u, output_capacity };
  ConversionStack stack = { NULL, 0u, 0u };
  int environment;
  int result;
  int call_status;
  int load_status;
  uint32_t payload_start;
  NamedFailure *failure;
  if (fuel_used != NULL) *fuel_used = 0u;
  if (state == NULL) return PDRV_RESOURCE_ALLOCATION;
  build_closed_environment(state);
  environment = lua_absindex(state, 1);
  result = inject_test_authority(state, environment, channel);
  if (result != 0) { lua_close(state); return result; }
  load_status = luaL_loadbufferx(state, (const char *)source, source_length, "@device.lua", "t");
  if (load_status != LUA_OK) {
    if (fuel_used != NULL) *fuel_used = limits.fuel_used;
    lua_close(state);
    return load_status == LUA_ERRMEM ? PDRV_RESOURCE_ALLOCATION : PDRV_ENV_SOURCE;
  }
  lua_pushvalue(state, environment);
  if (lua_setupvalue(state, -2, 1) == NULL) {
    lua_close(state);
    return PDRV_ENV_SOURCE;
  }
  lua_sethook(state, charge_instruction, LUA_MASKCOUNT, 1);
  call_status = lua_pcall(state, 0, admission ? LUA_MULTRET : 1, 0);
  result = resource_failure(&limits, call_status);
  if (result != 0) {
    if (fuel_used != NULL) *fuel_used = limits.fuel_used;
    lua_close(state);
    return result;
  }
  if (call_status != LUA_OK) {
    if (fuel_used != NULL) *fuel_used = limits.fuel_used;
    failure = lua_type(state, -1) == LUA_TUSERDATA
      ? (NamedFailure *)lua_touserdata(state, -1) : NULL;
    if (failure == NULL || failure->magic != PDRV_FAILURE_MAGIC) {
      result = program_error_code(state);
      lua_close(state);
      return result;
    }
    result = write_bytes(&writer, "PDRV", 4u);
    if (result == 0) result = write_u8(&writer, 1u);
    if (result == 0) result = write_u8(&writer, 0x04u);
    if (result == 0) result = write_u32(&writer, 0u);
    payload_start = writer.length;
    if (result == 0 && lua_getiuservalue(state, -1, 1) == LUA_TSTRING) {
      result = write_name(state, -1, &writer);
      lua_pop(state, 1);
    } else if (result == 0) {
      lua_pop(state, 1);
      result = PDRV_ENV_PROGRAM;
    }
    if (result == 0 && lua_getiuservalue(state, -1, 2) == LUA_TTABLE) {
      result = encode_value(state, -1, &writer);
      lua_pop(state, 1);
    } else if (result == 0) {
      lua_pop(state, 1);
      result = PDRV_ENV_PROGRAM;
    }
  } else if (admission) {
    if (lua_gettop(state) != environment + 2) result = PDRV_ENV_ADMISSION_EXPORTS;
    else {
      result = encode_admission_result(state, -2, -1, &writer, &stack, &payload_start);
    }
  } else {
    result = authored_to_tagged(state, -1, &stack);
    if (result == 0) {
      lua_remove(state, -2);
      result = write_bytes(&writer, "PDRV", 4u);
      if (result == 0) result = write_u8(&writer, 1u);
      if (result == 0) result = write_u8(&writer, 0x01u);
      if (result == 0) result = write_u32(&writer, 0u);
      payload_start = writer.length;
      if (result == 0) result = encode_value(state, -1, &writer);
    }
  }
  pdrv_scratch_free(stack.tables);
  if (result == 0) patch_u32(&writer, 6u, writer.length - payload_start);
  if (fuel_used != NULL) *fuel_used = limits.fuel_used;
  lua_close(state);
  return result == 0 ? (int)writer.length : result;
}

static int environment_member_compare(const void *left_value, const void *right_value) {
  const EnvironmentMember *left = (const EnvironmentMember *)left_value;
  const EnvironmentMember *right = (const EnvironmentMember *)right_value;
  return bytes_compare(
    (const uint8_t *)left->bytes, left->length,
    (const uint8_t *)right->bytes, right->length);
}

static int add_environment_member(EnvironmentMember **members, size_t *count, size_t *capacity,
    const char *prefix, size_t prefix_length, const char *name, size_t name_length) {
  EnvironmentMember *grown;
  char *bytes;
  size_t length = prefix_length + (prefix_length == 0u ? 0u : 1u) + name_length;
  if (*count == *capacity) {
    size_t next_capacity = *capacity == 0u ? 16u : *capacity * 2u;
    grown = (EnvironmentMember *)pdrv_scratch_realloc(*members, next_capacity * sizeof(*grown));
    if (grown == NULL) return PDRV_ABI_CAPACITY;
    *members = grown;
    *capacity = next_capacity;
  }
  bytes = (char *)pdrv_scratch_malloc(length);
  if (bytes == NULL) return PDRV_ABI_CAPACITY;
  if (prefix_length != 0u) {
    PDRV_NATIVE_BLOCKS(prefix_length);
    memcpy(bytes, prefix, prefix_length);
    bytes[prefix_length] = '.';
  }
  PDRV_NATIVE_BLOCKS(name_length);
  memcpy(bytes + prefix_length + (prefix_length == 0u ? 0u : 1u), name, name_length);
  (*members)[*count].bytes = bytes;
  (*members)[*count].length = length;
  *count += 1u;
  return 0;
}

static int describe_environment(uint8_t *output, uint32_t output_capacity) {
  lua_State *state = luaL_newstate();
  EnvironmentMember *members = NULL;
  size_t count = 0u;
  size_t capacity = 0u;
  size_t index;
  Writer writer = { output, 0u, output_capacity };
  int result = 0;
  if (state == NULL) return PDRV_ABI_CAPACITY;
  build_closed_environment(state);
  lua_pushnil(state);
  while (result == 0 && lua_next(state, 1) != 0) {
    PDRV_NATIVE_ITERATION();
    size_t root_length;
    const char *root;
    int value = lua_absindex(state, -1);
    if (lua_type(state, -2) != LUA_TSTRING) { result = PDRV_ENV_BOUNDARY; lua_pop(state, 2); break; }
    root = lua_tolstring(state, -2, &root_length);
    result = add_environment_member(&members, &count, &capacity, "", 0u, root, root_length);
    if (result == 0 && lua_istable(state, value)
        && !(root_length == 2u && memcmp(root, "_G", 2u) == 0)) {
      lua_pushnil(state);
      while (result == 0 && lua_next(state, value) != 0) {
        PDRV_NATIVE_ITERATION();
        size_t nested_length;
        const char *nested;
        if (lua_type(state, -2) != LUA_TSTRING) { result = PDRV_ENV_BOUNDARY; lua_pop(state, 2); break; }
        nested = lua_tolstring(state, -2, &nested_length);
        result = add_environment_member(&members, &count, &capacity, root, root_length, nested, nested_length);
        lua_pop(state, 1);
      }
    }
    lua_pop(state, 1);
  }
  if (result == 0) {
    qsort(members, count, sizeof(*members), environment_member_compare);
    for (index = 0u; result == 0 && index < count; index += 1u) {
      PDRV_NATIVE_ITERATION();
      result = write_bytes(&writer, members[index].bytes, (uint32_t)members[index].length);
      if (result == 0) result = write_u8(&writer, '\n');
    }
  }
  for (index = 0u; index < count; index += 1u) pdrv_scratch_free(members[index].bytes);
  pdrv_scratch_free(members);
  lua_close(state);
  return result == 0 ? (int)writer.length : result;
}

static int decode_value(lua_State *state, Reader *reader) {
  PDRV_NATIVE_ITERATION();
#ifdef PDRV_RETAINED_DISPATCH
  if (!lua_checkstack(state, 32)) return PDRV_RESOURCE_ALLOCATION;
#endif
  uint8_t tag;
  uint32_t length;
  Reader content;
  uint32_t count;
  uint32_t index;
  if (!read_u8(reader, &tag) || !read_u32(reader, &length) || !read_region(reader, length, &content)) {
    return PDRV_ABI_MALFORMED;
  }
  new_value(state, tag);
  if (tag == 0x01u || tag == 0x02u) {
    if (length != 0u) return PDRV_ABI_MALFORMED;
    lua_pushboolean(state, tag == 0x02u);
    lua_rawseti(state, -2, 2);
  } else if (tag == 0x03u || tag == 0x04u) {
    if (length != 8u) return PDRV_ABI_MALFORMED;
    lua_pushlstring(state, (const char *)content.cursor, 8u);
    lua_rawseti(state, -2, 2);
    content.cursor = content.end;
  } else if (tag == 0x05u) {
    if (length < 1u || content.cursor[0] > 1u
        || (length == 1u && content.cursor[0] != 0u)
        || (length > 1u && content.cursor[1] == 0u)) return PDRV_ABI_MALFORMED;
    PDRV_NATIVE_BLOCKS(length);
    lua_pushlstring(state, (const char *)content.cursor, length);
    lua_rawseti(state, -2, 2);
    content.cursor = content.end;
  } else if (tag == 0x06u) {
    uint64_t bits = 0u;
    double number;
    if (length != 8u) return PDRV_ABI_MALFORMED;
    for (index = 0u; index < 8u; index += 1u) bits = (bits << 8) | content.cursor[index];
    memcpy(&number, &bits, sizeof(number));
    if (!isfinite(number)) return PDRV_ABI_NONFINITE;
    if (number == 0.0 && signbit(number)) return PDRV_ABI_NEGATIVE_ZERO;
    lua_pushnumber(state, (lua_Number)number);
    lua_rawseti(state, -2, 2);
    content.cursor = content.end;
  } else if (tag == 0x07u || tag == 0x08u) {
    if (tag == 0x07u && !valid_utf8(content.cursor, length)) return PDRV_ABI_MALFORMED;
    PDRV_NATIVE_BLOCKS(length);
    lua_pushlstring(state, (const char *)content.cursor, length);
    lua_rawseti(state, -2, 2);
    content.cursor = content.end;
  } else if (tag == 0x09u) {
    if (!read_u32(&content, &count)) return PDRV_ABI_MALFORMED;
    lua_createtable(state, (int)count, 0);
    for (index = 0u; index < count; index += 1u) {
      PDRV_NATIVE_ITERATION();
      int result = decode_value(state, &content);
      if (result != 0) return result;
      lua_rawseti(state, -2, (lua_Integer)index + 1);
    }
    lua_rawseti(state, -2, 2);
  } else if (tag == 0x0au) {
    const uint8_t *prior = NULL;
    size_t prior_length = 0u;
    if (!read_u32(&content, &count)) return PDRV_ABI_MALFORMED;
    lua_createtable(state, (int)count, 0);
    for (index = 0u; index < count; index += 1u) {
      PDRV_NATIVE_ITERATION();
      uint32_t key_length;
      Reader key;
      if (!read_u32(&content, &key_length) || !read_region(&content, key_length, &key)
          || key_length == 0u || !valid_utf8(key.cursor, key_length)
          || (prior != NULL && bytes_compare(prior, prior_length, key.cursor, key_length) >= 0)) {
        return PDRV_ABI_MALFORMED;
      }
      lua_createtable(state, 2, 0);
      PDRV_NATIVE_BLOCKS(key_length);
      lua_pushlstring(state, (const char *)key.cursor, key_length);
      lua_rawseti(state, -2, 1);
      prior = key.cursor;
      prior_length = key_length;
      key.cursor = key.end;
      {
        int result = decode_value(state, &content);
        if (result != 0) return result;
      }
      lua_rawseti(state, -2, 2);
      lua_rawseti(state, -2, (lua_Integer)index + 1);
    }
    lua_rawseti(state, -2, 2);
  } else if (tag == 0x0bu) {
    uint32_t name_length;
    Reader name;
    if (!read_u32(&content, &name_length) || !read_region(&content, name_length, &name)
        || name_length == 0u || !valid_utf8(name.cursor, name_length)) return PDRV_ABI_MALFORMED;
    lua_createtable(state, 2, 0);
    PDRV_NATIVE_BLOCKS(name_length);
    lua_pushlstring(state, (const char *)name.cursor, name_length);
    lua_rawseti(state, -2, 1);
    name.cursor = name.end;
    {
      int result = decode_value(state, &content);
      if (result != 0) return result;
    }
    lua_rawseti(state, -2, 2);
    lua_rawseti(state, -2, 2);
  } else if (tag == 0x0cu) {
    if (length != 0u) return PDRV_ABI_MALFORMED;
  } else {
    return PDRV_ABI_MALFORMED;
  }
  return content.cursor == content.end ? 0 : PDRV_ABI_MALFORMED;
}

static int encode_value(lua_State *state, int value_index, Writer *writer) {
  PDRV_NATIVE_ITERATION();
#ifdef PDRV_RETAINED_DISPATCH
  if (!lua_checkstack(state, 32)) return PDRV_RESOURCE_ALLOCATION;
#endif
  int absolute = lua_absindex(state, value_index);
  lua_Integer tag_integer;
  uint8_t tag;
  uint32_t length_offset;
  uint32_t content_start;
  int result = 0;
  if (!lua_istable(state, absolute)) return PDRV_ABI_FORBIDDEN;
  lua_rawgeti(state, absolute, 1);
  if (!lua_isinteger(state, -1)) { lua_pop(state, 1); return PDRV_ABI_FORBIDDEN; }
  tag_integer = lua_tointeger(state, -1);
  lua_pop(state, 1);
  if (tag_integer < 1 || tag_integer > 0x0c) return PDRV_ABI_FORBIDDEN;
  tag = (uint8_t)tag_integer;
  if ((result = write_u8(writer, tag)) != 0) return result;
  length_offset = writer->length;
  if ((result = write_u32(writer, 0u)) != 0) return result;
  content_start = writer->length;
  lua_rawgeti(state, absolute, 2);
  if (tag == 0x01u || tag == 0x02u) {
    if (!lua_isboolean(state, -1) || lua_toboolean(state, -1) != (tag == 0x02u)) result = PDRV_ABI_FORBIDDEN;
  } else if (tag == 0x03u || tag == 0x04u) {
    size_t length;
    const char *bytes = lua_tolstring(state, -1, &length);
    if (bytes == NULL || length != 8u) result = PDRV_ABI_FORBIDDEN;
    else result = write_bytes(writer, bytes, 8u);
  } else if (tag == 0x05u || tag == 0x07u || tag == 0x08u) {
    size_t length;
    const char *bytes = lua_tolstring(state, -1, &length);
    if (bytes == NULL || length > UINT32_MAX) result = PDRV_ABI_FORBIDDEN;
    else if (tag == 0x05u && (length < 1u || (uint8_t)bytes[0] > 1u
        || (length == 1u && bytes[0] != 0) || (length > 1u && bytes[1] == 0))) result = PDRV_ABI_FORBIDDEN;
    else if (tag == 0x07u && !valid_utf8((const uint8_t *)bytes, length)) result = PDRV_ABI_FORBIDDEN;
    else result = write_bytes(writer, bytes, (uint32_t)length);
  } else if (tag == 0x06u) {
    double number;
    uint64_t bits;
    uint8_t bytes[8];
    uint32_t index;
    if (!lua_isnumber(state, -1)) result = PDRV_ABI_FORBIDDEN;
    else {
      number = (double)lua_tonumber(state, -1);
      if (!isfinite(number)) result = PDRV_ABI_NONFINITE;
      else if (number == 0.0 && signbit(number)) result = PDRV_ABI_NEGATIVE_ZERO;
      else {
        memcpy(&bits, &number, sizeof(bits));
        for (index = 0u; index < 8u; index += 1u) bytes[7u - index] = (uint8_t)(bits >> (index * 8u));
        result = write_bytes(writer, bytes, 8u);
      }
    }
  } else if (tag == 0x09u || tag == 0x0au) {
    uint32_t count;
    uint32_t index;
    if (!lua_istable(state, -1) || lua_rawlen(state, -1) > UINT32_MAX) result = PDRV_ABI_FORBIDDEN;
    else {
      int payload = lua_absindex(state, -1);
      count = (uint32_t)lua_rawlen(state, payload);
      result = write_u32(writer, count);
      for (index = 0u; result == 0 && index < count; index += 1u) {
        PDRV_NATIVE_ITERATION();
        lua_rawgeti(state, payload, (lua_Integer)index + 1);
        if (tag == 0x09u) {
          result = encode_value(state, -1, writer);
        } else if (!lua_istable(state, -1)) {
          result = PDRV_ABI_FORBIDDEN;
        } else {
          int entry = lua_absindex(state, -1);
          size_t key_length;
          const char *key;
          lua_rawgeti(state, entry, 1);
          key = lua_tolstring(state, -1, &key_length);
          if (key == NULL || key_length == 0u || key_length > UINT32_MAX || !valid_utf8((const uint8_t *)key, key_length)) {
            result = PDRV_ABI_FORBIDDEN;
          } else if ((result = write_u32(writer, (uint32_t)key_length)) == 0) {
            result = write_bytes(writer, key, (uint32_t)key_length);
          }
          lua_pop(state, 1);
          if (result == 0) {
            lua_rawgeti(state, entry, 2);
            result = encode_value(state, -1, writer);
            lua_pop(state, 1);
          }
        }
        lua_pop(state, 1);
      }
    }
  } else if (tag == 0x0bu) {
    if (!lua_istable(state, -1)) result = PDRV_ABI_FORBIDDEN;
    else {
      int payload = lua_absindex(state, -1);
      size_t name_length;
      const char *name;
      lua_rawgeti(state, payload, 1);
      name = lua_tolstring(state, -1, &name_length);
      if (name == NULL || name_length == 0u || name_length > UINT32_MAX || !valid_utf8((const uint8_t *)name, name_length)) {
        result = PDRV_ABI_FORBIDDEN;
      } else if ((result = write_u32(writer, (uint32_t)name_length)) == 0) {
        result = write_bytes(writer, name, (uint32_t)name_length);
      }
      lua_pop(state, 1);
      if (result == 0) {
        lua_rawgeti(state, payload, 2);
        result = encode_value(state, -1, writer);
        lua_pop(state, 1);
      }
    }
  } else if (tag == 0x0cu) {
    if (!lua_isnil(state, -1)) result = PDRV_ABI_FORBIDDEN;
  }
  lua_pop(state, 1);
  if (result != 0) return result;
  patch_u32(writer, length_offset, writer->length - content_start);
  return 0;
}

static int read_name(lua_State *state, Reader *reader) {
  uint32_t length;
  Reader name;
  if (!read_u32(reader, &length) || !read_region(reader, length, &name)
      || length == 0u || !valid_utf8(name.cursor, length)) return PDRV_ABI_MALFORMED;
  PDRV_NATIVE_BLOCKS(length);
  lua_pushlstring(state, (const char *)name.cursor, length);
  name.cursor = name.end;
  return 0;
}

static int write_name(lua_State *state, int index, Writer *writer) {
  size_t length;
  const char *name = lua_tolstring(state, index, &length);
  int result;
  if (name == NULL || length == 0u || length > UINT32_MAX || !valid_utf8((const uint8_t *)name, length)) {
    return PDRV_ABI_FORBIDDEN;
  }
  result = write_u32(writer, (uint32_t)length);
  return result == 0 ? write_bytes(writer, name, (uint32_t)length) : result;
}

static int roundtrip(lua_State *state, const uint8_t *input, uint32_t input_length,
    uint8_t *output, uint32_t output_capacity) {
  Reader reader = { input, input + input_length };
  Writer writer = { output, 0u, output_capacity };
  uint8_t magic[4];
  uint8_t version;
  uint8_t kind;
  uint32_t payload_length;
  uint32_t output_payload;
  uint32_t index;
  int result;
  for (index = 0u; index < 4u; index += 1u) if (!read_u8(&reader, &magic[index])) return PDRV_ABI_MALFORMED;
  if (memcmp(magic, "PDRV", 4u) != 0 || !read_u8(&reader, &version) || version != 1u
      || !read_u8(&reader, &kind) || !read_u32(&reader, &payload_length)
      || payload_length != (uint32_t)(reader.end - reader.cursor)) return PDRV_ABI_MALFORMED;
  if ((result = write_bytes(&writer, "PDRV", 4u)) != 0 || (result = write_u8(&writer, 1u)) != 0
      || (result = write_u8(&writer, kind)) != 0 || (result = write_u32(&writer, 0u)) != 0) return result;
  output_payload = writer.length;

  if (kind == 0x01u) {
    result = decode_value(state, &reader);
    if (result == 0 && reader.cursor == reader.end) result = encode_value(state, -1, &writer);
  } else if (kind == 0x02u) {
    uint32_t count;
    result = decode_value(state, &reader);
    if (result == 0) {
      lua_rawgeti(state, -1, 1);
      if (lua_tointeger(state, -1) != 0x0a) result = PDRV_ABI_MALFORMED;
      lua_pop(state, 1);
    }
    if (result == 0 && !read_u32(&reader, &count)) result = PDRV_ABI_MALFORMED;
    if (result == 0) {
      lua_createtable(state, (int)count, 0);
      for (index = 0u; result == 0 && index < count; index += 1u) {
        PDRV_NATIVE_ITERATION();
        result = read_name(state, &reader);
        if (result == 0) lua_rawseti(state, -2, (lua_Integer)index + 1);
      }
      if (result == 0) result = encode_value(state, -2, &writer);
      if (result == 0) result = write_u32(&writer, count);
      for (index = 0u; result == 0 && index < count; index += 1u) {
        PDRV_NATIVE_ITERATION();
        lua_rawgeti(state, -1, (lua_Integer)index + 1);
        result = write_name(state, -1, &writer);
        lua_pop(state, 1);
      }
    }
  } else if (kind == 0x03u || kind == 0x04u) {
    result = read_name(state, &reader);
    if (result == 0) result = decode_value(state, &reader);
    if (result == 0) result = write_name(state, -2, &writer);
    if (result == 0) result = encode_value(state, -1, &writer);
  } else {
    result = PDRV_ABI_MALFORMED;
  }
  if (result != 0) return result;
  if (reader.cursor != reader.end) return PDRV_ABI_MALFORMED;
  patch_u32(&writer, 6u, writer.length - output_payload);
  return (int)writer.length;
}

EMSCRIPTEN_KEEPALIVE uint32_t pdrv_lua_vm_artifact_contract(void) {
  return PDRV_LUA_VM_ARTIFACT_CONTRACT;
}

EMSCRIPTEN_KEEPALIVE uint32_t pdrv_lua_integer_bits(void) {
  return (uint32_t)(sizeof(lua_Integer) * 8u);
}

EMSCRIPTEN_KEEPALIVE uint32_t pdrv_lua_number_bits(void) {
  return (uint32_t)(sizeof(lua_Number) * 8u);
}

EMSCRIPTEN_KEEPALIVE uint32_t pdrv_lua_seed(void) {
  lua_State *state = luaL_newstate();
  uint32_t seed;
  if (state == NULL) return 0u;
  seed = (uint32_t)G(state)->seed;
  lua_close(state);
  return seed;
}

EMSCRIPTEN_KEEPALIVE int32_t pdrv_lua_environment_describe(
    uint8_t *output, uint32_t output_capacity) {
  return describe_environment(output, output_capacity);
}

EMSCRIPTEN_KEEPALIVE int32_t pdrv_lua_environment_execute(
    const uint8_t *source, uint32_t source_length,
    uint8_t *output, uint32_t output_capacity) {
  return execute_closed_source(
    source, source_length, output, output_capacity, 0u, UINT32_MAX, UINT32_MAX, NULL, 0);
}

EMSCRIPTEN_KEEPALIVE int32_t pdrv_lua_environment_execute_bounded(
    const uint8_t *source, uint32_t source_length,
    uint8_t *output, uint32_t output_capacity,
    uint32_t allocation_limit, uint32_t fuel_limit, uint32_t *fuel_used) {
  if (allocation_limit == 0u || fuel_limit == 0u || fuel_used == NULL) return PDRV_ABI_MALFORMED;
  return execute_closed_source(
    source, source_length, output, output_capacity, 0u, allocation_limit, fuel_limit, fuel_used, 0);
}

EMSCRIPTEN_KEEPALIVE int32_t pdrv_lua_environment_execute_admission_bounded(
    const uint8_t *source, uint32_t source_length,
    uint8_t *output, uint32_t output_capacity,
    uint32_t allocation_limit, uint32_t fuel_limit, uint32_t *fuel_used) {
  if (allocation_limit == 0u || fuel_limit == 0u || fuel_used == NULL) return PDRV_ABI_MALFORMED;
  return execute_closed_source(
    source, source_length, output, output_capacity, 0u, allocation_limit, fuel_limit, fuel_used, 1);
}

static int32_t open_invocation_admission_bounded(
    const uint8_t *source, uint32_t source_length,
    uint8_t *output, uint32_t output_capacity,
    uint32_t allocation_limit, uint32_t fuel_limit, uint32_t *fuel_used,
    uint32_t *handle_output, uint32_t channel) {
  InvocationHandle *handle;
  lua_State *state;
  Writer writer = { output, 0u, output_capacity };
  ConversionStack stack = { NULL, 0u, 0u };
  uint32_t payload_start = 0u;
  int environment;
  int load_status;
  int call_status;
  int result;
  if (allocation_limit == 0u || fuel_limit == 0u || fuel_used == NULL || handle_output == NULL) {
    return PDRV_ABI_MALFORMED;
  }
  *fuel_used = 0u;
  *handle_output = 0u;
  handle = (InvocationHandle *)calloc(1u, sizeof(*handle));
  if (handle == NULL) return PDRV_RESOURCE_ALLOCATION;
  handle->limits.allocation_limit = allocation_limit;
  handle->limits.fuel_limit = fuel_limit;
  state = lua_newstate(bounded_lua_allocator, &handle->limits, 0x50445256u);
  if (state == NULL) { free(handle); return PDRV_RESOURCE_ALLOCATION; }
  handle->state = state;
  build_closed_environment(state);
  environment = lua_absindex(state, 1);
  result = inject_test_authority(state, environment, channel);
  if (result != 0) goto fail;
  load_status = luaL_loadbufferx(state, (const char *)source, source_length, "@device.lua", "t");
  if (load_status != LUA_OK) {
    result = load_status == LUA_ERRMEM ? PDRV_RESOURCE_ALLOCATION : PDRV_ENV_SOURCE;
    goto fail;
  }
  lua_pushvalue(state, environment);
  if (lua_setupvalue(state, -2, 1) == NULL) { result = PDRV_ENV_SOURCE; goto fail; }
  lua_sethook(state, charge_instruction, LUA_MASKCOUNT, 1);
  call_status = lua_pcall(state, 0, LUA_MULTRET, 0);
  result = resource_failure(&handle->limits, call_status);
  if (result != 0) goto fail;
  if (call_status != LUA_OK) {
    result = program_error_code(state);
    goto fail;
  }
  if (lua_gettop(state) != environment + 2) { result = PDRV_ENV_ADMISSION_EXPORTS; goto fail; }
  result = encode_admission_result(state, -2, -1, &writer, &stack, &payload_start);
  if (result != 0) goto fail;
  patch_u32(&writer, 6u, writer.length - payload_start);
  *fuel_used = handle->limits.fuel_used;
  *handle_output = (uint32_t)(uintptr_t)handle;
  pdrv_scratch_free(stack.tables);
  return (int32_t)writer.length;

fail:
  *fuel_used = handle->limits.fuel_used;
  pdrv_scratch_free(stack.tables);
  lua_close(state);
  free(handle);
  return result;
}

EMSCRIPTEN_KEEPALIVE int32_t pdrv_lua_invocation_open_admission_bounded(
    const uint8_t *source, uint32_t source_length,
    uint8_t *output, uint32_t output_capacity,
    uint32_t allocation_limit, uint32_t fuel_limit, uint32_t *fuel_used,
    uint32_t *handle_output) {
  return open_invocation_admission_bounded(
    source, source_length, output, output_capacity,
    allocation_limit, fuel_limit, fuel_used, handle_output, 0u);
}

EMSCRIPTEN_KEEPALIVE int32_t pdrv_lua_invocation_execute_bounded(
    uint32_t handle_value, const uint8_t *input, uint32_t input_length,
    uint8_t *output, uint32_t output_capacity,
    uint32_t fuel_limit, uint32_t *fuel_used) {
  InvocationHandle *handle = (InvocationHandle *)(uintptr_t)handle_value;
  lua_State *state;
  Writer writer = { output, 0u, output_capacity };
  uint32_t payload_start = 0u;
  int result;
  int call_status;
  if (handle == NULL || handle->state == NULL || handle->used
      || fuel_limit == 0u || fuel_used == NULL) return PDRV_ABI_MALFORMED;
  handle->used = 1;
  handle->limits.fuel_used = 0u;
  handle->limits.fuel_limit = fuel_limit;
  handle->limits.fuel_exhausted = 0;
  handle->limits.allocation_exhausted = 0;
  *fuel_used = 0u;
  state = handle->state;
  lua_settop(state, 3);
  result = decode_program_invocation(state, input, input_length);
  if (result != 0) goto done;
  lua_pushvalue(state, 4);
  lua_rawget(state, 3);
  if (!lua_isfunction(state, -1)) { result = PDRV_ENV_INVOCATION_EXPORT; goto done; }
  lua_pushvalue(state, 5);
  call_status = lua_pcall(state, 1, 1, 0);
  result = encode_invocation_outcome(state, call_status, &writer, &payload_start, &handle->limits);
  if (result == 0) {
    patch_u32(&writer, 6u, writer.length - payload_start);
    result = (int)writer.length;
  }

done:
  *fuel_used = handle->limits.fuel_used;
  return result;
}

EMSCRIPTEN_KEEPALIVE void pdrv_lua_invocation_close(uint32_t handle_value) {
  InvocationHandle *handle = (InvocationHandle *)(uintptr_t)handle_value;
  if (handle == NULL) return;
  if (handle->state != NULL) lua_close(handle->state);
  handle->state = NULL;
  free(handle);
}

/* Diagnostic-only authority injection. Product host adapters never expose it. */
EMSCRIPTEN_KEEPALIVE int32_t pdrv_lua_environment_channel_probe(
    const uint8_t *source, uint32_t source_length,
    uint8_t *output, uint32_t output_capacity, uint32_t channel) {
  return execute_closed_source(
    source, source_length, output, output_capacity, channel, UINT32_MAX, UINT32_MAX, NULL, 0);
}

EMSCRIPTEN_KEEPALIVE int32_t pdrv_lua_vm_smoke(void) {
  static const char source[] = "return 40 + 2";
  lua_State *state = luaL_newstate();
  lua_Integer result;
  int is_integer;
  if (state == NULL) return -1;
  if (luaL_loadbufferx(state, source, sizeof(source) - 1u, "@artifact-smoke.lua", "t") != LUA_OK
      || lua_pcall(state, 0, 1, 0) != LUA_OK) { lua_close(state); return -2; }
  result = lua_tointegerx(state, -1, &is_integer);
  lua_close(state);
  return (!is_integer || result != 42) ? -3 : 42;
}

EMSCRIPTEN_KEEPALIVE int32_t pdrv_lua_value_abi_roundtrip(
    const uint8_t *input, uint32_t input_length, uint8_t *output, uint32_t output_capacity) {
  lua_State *state = luaL_newstate();
  int result;
  if (state == NULL) return PDRV_ABI_CAPACITY;
  result = roundtrip(state, input, input_length, output, output_capacity);
  lua_close(state);
  return result;
}

static int forbidden_function(lua_State *state) {
  (void)state;
  return 0;
}

EMSCRIPTEN_KEEPALIVE int32_t pdrv_lua_value_abi_rejection_probe(uint32_t probe) {
  lua_State *state = luaL_newstate();
  uint8_t output[32];
  Writer writer = { output, 0u, sizeof(output) };
  int result;
  if (state == NULL) return PDRV_ABI_CAPACITY;
  if (write_bytes(&writer, "PDRV\x01\x01\0\0\0\0", 10u) != 0) { lua_close(state); return PDRV_ABI_CAPACITY; }
  if (probe >= 1u && probe <= 4u) {
    double number = probe == 1u ? NAN : probe == 2u ? INFINITY : probe == 3u ? -INFINITY : -0.0;
    new_value(state, 0x06u);
    lua_pushnumber(state, (lua_Number)number);
    lua_rawseti(state, -2, 2);
  } else if (probe == 5u) {
    lua_pushcfunction(state, forbidden_function);
  } else if (probe == 6u) {
    lua_pushlightuserdata(state, state);
  } else {
    lua_close(state);
    return PDRV_ABI_MALFORMED;
  }
  result = encode_value(state, -1, &writer);
  lua_close(state);
  return result;
}
