/* Retained Lua executor wrapper; the one-use entry remains separate. */
#define PDRV_RETAINED_DISPATCH 1
#include "pdrv_retained_account.h"
#include "pdrv_lua_vm.c"

extern int32_t pdrv_retained_charge_work(uint32_t units)
    __attribute__((import_module("env"), import_name("pdrv_retained_charge_work")));

/* The boundary keeps its immutable Lua string rooted. No mutable host view
   or payload-sized copy is exposed by inspecting the private tag. */
static const unsigned char *retained_bytes(lua_State *state, int index, size_t *length) {
  if (lua_type(state, index) != LUA_TUSERDATA
      || lua_rawlen(state, index) != sizeof(AuthoredBoundary) || !boundary_value(state, index)) return NULL;
  lua_getiuservalue(state, index, 1);
  if (!lua_istable(state, -1)) { lua_pop(state, 1); return NULL; }
  lua_rawgeti(state, -1, 1);
  int bytes = lua_isinteger(state, -1) && lua_tointeger(state, -1) == 0x08;
  lua_pop(state, 1);
  if (!bytes) { lua_pop(state, 1); return NULL; }
  lua_rawgeti(state, -1, 2);
  const unsigned char *result = lua_type(state, -1) == LUA_TSTRING
      ? (const unsigned char *)lua_tolstring(state, -1, length) : NULL;
  lua_pop(state, 2);
  return result;
}

static int retained_bytes_equal(lua_State *state) {
  if (!pdrv_retained_charge_work(1u)) return luaL_error(state, "retained.work-exhausted");
  size_t left_length = 0, right_length = 0;
  const unsigned char *left = retained_bytes(state, 1, &left_length);
  const unsigned char *right = retained_bytes(state, 2, &right_length);
  if (!left || !right || left_length != right_length) { lua_pushboolean(state, 0); return 1; }
  /* Prefix-revealing, NOT token/MAC verification. Charge before each pair. */
  for (size_t i = 0; i < left_length; ++i) {
    if (!pdrv_retained_charge_work(1u)) return luaL_error(state, "retained.work-exhausted");
    if (left[i] != right[i]) { lua_pushboolean(state, 0); return 1; }
  }
  lua_pushboolean(state, 1); return 1;
}

static void retained_boundary_metatable(lua_State *state) {
  size_t length;
  if (!retained_bytes(state, -1, &length)) return;
  if (luaL_newmetatable(state, "pdrv.retained.bytes")) {
    lua_pushcfunction(state, retained_bytes_equal); lua_setfield(state, -2, "__eq");
    lua_pushboolean(state, 0); lua_setfield(state, -2, "__metatable");
  }
  lua_setmetatable(state, -2);
}

/* Keep v1 wire tags; remove the old pure-export input-shape restriction only
   for the retained entry. Recursive values reserve Lua API stack capacity. */
static int decoded_retained_nested(lua_State *state, int value_index, int host_envelope) {
  PDRV_NATIVE_ITERATION();
  if (!lua_checkstack(state, 32)) return PDRV_RESOURCE_ALLOCATION;
  int value = lua_absindex(state, value_index);
  lua_rawgeti(state, value, 1);
  int tag = (int)lua_tointeger(state, -1); lua_pop(state, 1);
  if (tag == 1 || tag == 2 || tag == 6 || tag == 7) {
    lua_rawgeti(state, value, 2); return 0;
  }
  if (tag == 3) return decoded_invocation_scalar(state, value);
  if (tag == 4 || tag == 5 || tag == 8 || tag == 11 || tag == 12) {
    lua_pushvalue(state, value); push_boundary(state); return 0;
  }
  if (tag != 9 && tag != 10) return PDRV_ABI_FORBIDDEN;
  int base = lua_gettop(state);
  lua_rawgeti(state, value, 2);
  int members = lua_absindex(state, -1);
  size_t count = lua_rawlen(state, members);
  lua_createtable(state, tag == 9 ? (int)count : 0, tag == 10 ? (int)count : 0);
  int destination = lua_absindex(state, -1);
  for (size_t i = 1; i <= count; ++i) {
    PDRV_NATIVE_ITERATION();
    lua_rawgeti(state, members, (lua_Integer)i);
    int member = lua_absindex(state, -1);
    if (tag == 10) { lua_rawgeti(state, member, 1); lua_rawgeti(state, member, 2); }
    int child = lua_absindex(state, -1);
    size_t raw_maximum = 0;
    if (host_envelope && tag == 10) {
      size_t key_length = 0;
      const char *key = lua_tolstring(state, child - 1, &key_length);
      if (key && key_length == 9 && memcmp(key, "rawOctets", 9) == 0) raw_maximum = 256;
      /* B4 complete-carrier authorization, never ordinary input/cleanup.
         The host also checks this task's narrower declared argument bound. */
      if (key && key_length == 11 && memcmp(key, "relayOctets", 11) == 0) raw_maximum = 65536;
    }
    int result;
    if (raw_maximum) {
      /* Only the trusted host envelope, NEVER an authored argument record.
         Reuse the decoder's rooted immutable string, without a per-octet AST. */
      lua_rawgeti(state, child, 1);
      int child_tag = (int)lua_tointeger(state, -1); lua_pop(state, 1);
      lua_rawgeti(state, child, 2);
      if (child_tag != 8 || lua_type(state, -1) != LUA_TSTRING || lua_rawlen(state, -1) > raw_maximum)
        result = PDRV_ABI_FORBIDDEN;
      else result = 0;
    } else result = decoded_retained_nested(state, child, 0);
    if (result != 0) { lua_settop(state, base); return result; }
    lua_remove(state, child);
    if (tag == 10) { lua_remove(state, member); lua_rawset(state, destination); }
    else lua_rawseti(state, destination, (lua_Integer)i);
  }
  lua_remove(state, members);
  push_readonly(state, tag == 9);
  return 0;
}

static int decoded_retained_value(lua_State *state, int value_index) {
  return decoded_retained_nested(state, value_index, 1);
}

EMSCRIPTEN_KEEPALIVE int32_t pdrv_retained_dispatch(
    uint32_t handle_value, const uint8_t *input, uint32_t input_length,
    uint8_t *output, uint32_t output_capacity,
    uint32_t remaining_fuel, uint32_t *fuel_used) {
  InvocationHandle *handle = (InvocationHandle *)(uintptr_t)handle_value;
  if (handle == NULL || handle->state == NULL) return PDRV_ABI_MALFORMED;
  int failed = resource_failure(&handle->limits, LUA_OK);
  if (failed != 0) return failed;
  handle->used = 0;
  return pdrv_lua_invocation_execute_bounded(handle_value, input, input_length,
      output, output_capacity, remaining_fuel, fuel_used);
}

/* Product result port. The old experiment entry above is intentionally intact.
   -2 remains scratch/conversion failure; ONLY this writer can issue -26.
   A pending converted outcome forbids dispatch until encoded or closed. */
#define PDRV_RESULT_OUTPUT -26
#define PDRV_RESULT_WORK -27
#define PDRV_RESULT_DEPTH -28
#define PDRV_RESULT_MAX_VALUE_DEPTH 128u
typedef struct {
  InvocationHandle *invocation;
  int pending;
  int root;
  int call_status;
  uint64_t encoded_length;
} RetainedResult;

#define PDRV_SOURCE_MEMBER_FAILURE_MAGIC 0x5044524du
typedef struct { uint32_t magic; } SourceMemberFailure;

/* Retained-v2 admission wraps the unchanged v1 require closure. Authored
   named failures remain authored; only ordinary member-load failures become
   the separately tagged, coarse host diagnostic selected by K8. */
static int retained_require(lua_State *state) {
  int attributable = lua_gettop(state) == 1 && lua_type(state, 1) == LUA_TSTRING;
  size_t member_length = 0u;
  const char *member = attributable ? lua_tolstring(state, 1, &member_length) : NULL;
  if (member == NULL || member_length == 0u || member_length > UINT32_MAX
      || !valid_utf8((const uint8_t *)member, member_length)) attributable = 0;
  int member_present = attributable && pdrv_lua_require_source(
    (const uint8_t *)member, (uint32_t)member_length, NULL, 0u) >= 0;
  lua_pushvalue(state, lua_upvalueindex(1));
  lua_pushvalue(state, 1);
  int status = lua_pcall(state, 1, 1, 0);
  if (status == LUA_OK) return 1;
  if (!attributable || lua_type(state, -1) == LUA_TUSERDATA) return lua_error(state);
  const char *reason = member_present ? "initialization-failed" : "missing";
  lua_settop(state, 1);
  SourceMemberFailure *failure = (SourceMemberFailure *)lua_newuserdatauv(
    state, sizeof(*failure), 2);
  failure->magic = PDRV_SOURCE_MEMBER_FAILURE_MAGIC;
  lua_pushvalue(state, 1); lua_setiuservalue(state, -2, 1);
  lua_pushstring(state, reason); lua_setiuservalue(state, -2, 2);
  return lua_error(state);
}

static void install_retained_require(lua_State *state, int environment_index) {
  int environment = lua_absindex(state, environment_index);
  lua_getfield(state, environment, "require");
  lua_pushcclosure(state, retained_require, 1);
  lua_setfield(state, environment, "require");
}

static int result_bytes(Writer *writer, const void *bytes, uint32_t length) {
  if (length > writer->capacity - writer->length) return PDRV_RESULT_OUTPUT;
  /* Charge the native copy's entry and bounded byte blocks, not Lua fuel. */
  if (!pdrv_retained_charge_work(1u + length / 256u + (length % 256u != 0u)))
    return PDRV_RESULT_WORK;
  return write_bytes_accounted_elsewhere(writer, bytes, length);
}
static int result_u8(Writer *writer, uint8_t value) {
  return result_bytes(writer, &value, 1u);
}
static int result_u32(Writer *writer, uint32_t value) {
  uint8_t bytes[4] = { value >> 24, value >> 16, value >> 8, value };
  return result_bytes(writer, bytes, 4u);
}
static int encode_result_value(lua_State *state, int value_index, Writer *writer, unsigned depth) {
  if (depth > PDRV_RESULT_MAX_VALUE_DEPTH) return PDRV_RESULT_DEPTH;
#ifdef PDRV_RETAINED_DISPATCH
  if (!lua_checkstack(state, 32)) return PDRV_RESOURCE_ALLOCATION;
#endif
  if (!pdrv_retained_charge_work(1u)) return PDRV_RESULT_WORK;
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
  if ((result = result_u8(writer, tag)) != 0) return result;
  length_offset = writer->length;
  if ((result = result_u32(writer, 0u)) != 0) return result;
  content_start = writer->length;
  lua_rawgeti(state, absolute, 2);
  if (tag == 0x01u || tag == 0x02u) {
    if (!lua_isboolean(state, -1) || lua_toboolean(state, -1) != (tag == 0x02u)) result = PDRV_ABI_FORBIDDEN;
  } else if (tag == 0x03u || tag == 0x04u) {
    size_t length;
    const char *bytes = lua_tolstring(state, -1, &length);
    if (bytes == NULL || length != 8u) result = PDRV_ABI_FORBIDDEN;
    else result = result_bytes(writer, bytes, 8u);
  } else if (tag == 0x05u || tag == 0x07u || tag == 0x08u) {
    size_t length;
    const char *bytes = lua_tolstring(state, -1, &length);
    if (bytes == NULL || length > UINT32_MAX) result = PDRV_ABI_FORBIDDEN;
    else if (!pdrv_retained_charge_work(1u + (uint32_t)(length / 256u) + (length % 256u != 0u))) result = PDRV_RESULT_WORK;
    else if (tag == 0x05u && (length < 1u || (uint8_t)bytes[0] > 1u
        || (length == 1u && bytes[0] != 0) || (length > 1u && bytes[1] == 0))) result = PDRV_ABI_FORBIDDEN;
    else if (tag == 0x07u && !valid_utf8((const uint8_t *)bytes, length)) result = PDRV_ABI_FORBIDDEN;
    else result = result_bytes(writer, bytes, (uint32_t)length);
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
        result = result_bytes(writer, bytes, 8u);
      }
    }
  } else if (tag == 0x09u || tag == 0x0au) {
    uint32_t count;
    uint32_t index;
    if (!lua_istable(state, -1) || lua_rawlen(state, -1) > UINT32_MAX) result = PDRV_ABI_FORBIDDEN;
    else {
      int payload = lua_absindex(state, -1);
      count = (uint32_t)lua_rawlen(state, payload);
      result = result_u32(writer, count);
      for (index = 0u; result == 0 && index < count; index += 1u) {
        if (!pdrv_retained_charge_work(1u)) { result = PDRV_RESULT_WORK; break; }
        lua_rawgeti(state, payload, (lua_Integer)index + 1);
        if (tag == 0x09u) {
          result = encode_result_value(state, -1, writer, depth + 1u);
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
          } else if ((result = result_u32(writer, (uint32_t)key_length)) == 0) {
            result = result_bytes(writer, key, (uint32_t)key_length);
          }
          lua_pop(state, 1);
          if (result == 0) {
            lua_rawgeti(state, entry, 2);
            result = encode_result_value(state, -1, writer, depth + 1u);
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
      } else if ((result = result_u32(writer, (uint32_t)name_length)) == 0) {
        result = result_bytes(writer, name, (uint32_t)name_length);
      }
      lua_pop(state, 1);
      if (result == 0) {
        lua_rawgeti(state, payload, 2);
        result = encode_result_value(state, -1, writer, depth + 1u);
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

/* Conversion is protected: an allocator refusal must not escape the VM as an
   unprotected Lua panic. A scratch failure is NOT a growable output failure. */
static int convert_result(lua_State *state) {
  ConversionStack *stack = (ConversionStack *)lua_touserdata(state, 2);
  int result = authored_to_tagged(state, 1, stack);
  if (result != 0) { lua_pushnil(state); lua_pushinteger(state, result); return 2; }
  lua_pushinteger(state, 0); return 2;
}

static int encode_retained_named_failure(lua_State *state, Writer *writer,
    uint32_t *payload_start) {
  int result = write_bytes(writer, "PDRV", 4u);
  if (result == 0) result = write_u8(writer, 1u);
  if (result == 0) result = write_u8(writer, 0x04u);
  if (result == 0) result = write_u32(writer, 0u);
  if (result == 0) *payload_start = writer->length;
  if (result == 0 && lua_getiuservalue(state, -1, 1) == LUA_TSTRING) {
    result = write_name(state, -1, writer); lua_pop(state, 1);
  } else if (result == 0) { lua_pop(state, 1); result = PDRV_ENV_PROGRAM; }
  if (result == 0 && lua_getiuservalue(state, -1, 2) == LUA_TTABLE) {
    result = encode_value(state, -1, writer); lua_pop(state, 1);
  } else if (result == 0) { lua_pop(state, 1); result = PDRV_ENV_PROGRAM; }
  return result;
}

static int encode_retained_source_member_failure(lua_State *state,
    Writer *writer, uint32_t *payload_start) {
  int result = write_bytes(writer, "PDRV", 4u);
  if (result == 0) result = write_u8(writer, 1u);
  if (result == 0) result = write_u8(writer, 0x05u);
  if (result == 0) result = write_u32(writer, 0u);
  if (result == 0) *payload_start = writer->length;
  if (result == 0 && lua_getiuservalue(state, -1, 1) == LUA_TSTRING) {
    result = write_name(state, -1, writer); lua_pop(state, 1);
  } else if (result == 0) { lua_pop(state, 1); result = PDRV_ENV_PROGRAM; }
  if (result == 0 && lua_getiuservalue(state, -1, 2) == LUA_TSTRING) {
    size_t length; const char *reason = lua_tolstring(state, -1, &length);
    uint8_t tag = length == 7u && memcmp(reason, "missing", 7u) == 0 ? 1u
      : length == 21u && memcmp(reason, "initialization-failed", 21u) == 0 ? 2u : 0u;
    lua_pop(state, 1);
    result = tag == 0u ? PDRV_ENV_PROGRAM : write_u8(writer, tag);
  } else if (result == 0) { lua_pop(state, 1); result = PDRV_ENV_PROGRAM; }
  return result;
}

static int32_t retained_open_invocation_admission_bounded(
    const uint8_t *source, uint32_t source_length,
    uint8_t *output, uint32_t output_capacity,
    uint32_t allocation_limit, uint32_t fuel_limit, uint32_t *fuel_used,
    uint32_t *handle_output) {
  InvocationHandle *handle;
  lua_State *state;
  Writer writer = { output, 0u, output_capacity };
  ConversionStack stack = { NULL, 0u, 0u };
  uint32_t payload_start = 0u;
  int environment, load_status, call_status, result;
  if (allocation_limit == 0u || fuel_limit == 0u || fuel_used == NULL
      || handle_output == NULL) return PDRV_ABI_MALFORMED;
  *fuel_used = 0u; *handle_output = 0u;
  handle = (InvocationHandle *)calloc(1u, sizeof(*handle));
  if (handle == NULL) return PDRV_RESOURCE_ALLOCATION;
  handle->limits.allocation_limit = allocation_limit;
  handle->limits.fuel_limit = fuel_limit;
  state = lua_newstate(bounded_lua_allocator, &handle->limits, 0x50445256u);
  if (state == NULL) { free(handle); return PDRV_RESOURCE_ALLOCATION; }
  handle->state = state;
  build_closed_environment(state);
  environment = lua_absindex(state, 1);
  install_retained_require(state, environment);
  load_status = luaL_loadbufferx(state, (const char *)source, source_length,
    "@device.lua", "t");
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
    void *failure = lua_type(state, -1) == LUA_TUSERDATA
        && lua_rawlen(state, -1) >= sizeof(uint32_t)
      ? lua_touserdata(state, -1) : NULL;
    uint32_t magic = failure == NULL ? 0u : *(uint32_t *)failure;
    if (magic == PDRV_FAILURE_MAGIC)
      result = encode_retained_named_failure(state, &writer, &payload_start);
    else if (magic == PDRV_SOURCE_MEMBER_FAILURE_MAGIC)
      result = encode_retained_source_member_failure(state, &writer, &payload_start);
    else { result = program_error_code(state); goto fail; }
  } else if (lua_gettop(state) != environment + 2) {
    result = PDRV_ENV_ADMISSION_EXPORTS;
  } else {
    result = encode_admission_result(state, -2, -1, &writer, &stack,
      &payload_start);
  }
  if (result != 0) goto fail;
  patch_u32(&writer, 6u, writer.length - payload_start);
  *fuel_used = handle->limits.fuel_used;
  *handle_output = (uint32_t)(uintptr_t)handle;
  pdrv_scratch_free(stack.tables);
  return (int32_t)writer.length;

fail:
  *fuel_used = handle->limits.fuel_used;
  pdrv_scratch_free(stack.tables);
  lua_close(state); free(handle);
  return result;
}

EMSCRIPTEN_KEEPALIVE int32_t pdrv_retained_result_open(
    const uint8_t *source, uint32_t source_length, uint8_t *output,
    uint32_t output_capacity, uint32_t allocation_limit, uint32_t fuel_limit,
  uint32_t *fuel_used, uint32_t *handle_output) {
  uint32_t inner = 0;
  retained_fuel_sink = fuel_used;
  int32_t count = retained_open_invocation_admission_bounded(source, source_length,
      output, output_capacity, allocation_limit, fuel_limit, fuel_used, &inner);
  retained_fuel_sink = NULL;
  *handle_output = 0;
  if (count < 0) return count;
  RetainedResult *result = (RetainedResult *)calloc(1, sizeof(*result));
  if (result == NULL) { pdrv_lua_invocation_close(inner); return PDRV_RESOURCE_ALLOCATION; }
  result->invocation = (InvocationHandle *)(uintptr_t)inner;
  *handle_output = (uint32_t)(uintptr_t)result;
  return count;
}

EMSCRIPTEN_KEEPALIVE void pdrv_retained_result_close(uint32_t value) {
  RetainedResult *result = (RetainedResult *)(uintptr_t)value;
  if (result == NULL) return;
  pdrv_lua_invocation_close((uint32_t)(uintptr_t)result->invocation);
  free(result);
}

/* Size the immutable tagged outcome once. This native traversal is charged;
   a short reservation must not repeatedly serialize prefixes of a large value. */
static int measure_result_value(lua_State *state, int index, uint64_t *size, unsigned depth) {
  if (depth > PDRV_RESULT_MAX_VALUE_DEPTH) return PDRV_RESULT_DEPTH;
  if (!lua_checkstack(state, 32)) return PDRV_RESOURCE_ALLOCATION;
  if (!pdrv_retained_charge_work(1u)) return PDRV_RESULT_WORK;
  int root = lua_absindex(state, index), top = lua_gettop(state), result = 0;
  lua_rawgeti(state, root, 1); int tag = (int)lua_tointeger(state, -1); lua_pop(state, 1);
  lua_rawgeti(state, root, 2); int payload = lua_absindex(state, -1);
  *size += 5u;
  if (tag == 3 || tag == 4 || tag == 6) *size += 8u;
  else if (tag == 5 || tag == 7 || tag == 8) *size += lua_rawlen(state, payload);
  else if (tag == 9 || tag == 10) {
    size_t count = lua_rawlen(state, payload); *size += 4u;
    for (size_t i = 1; i <= count && !result; ++i) {
      if (!pdrv_retained_charge_work(1u)) { result = PDRV_RESULT_WORK; break; }
      lua_rawgeti(state, payload, (lua_Integer)i);
      int member = lua_absindex(state, -1);
      if (tag == 10) {
        lua_rawgeti(state, member, 1); *size += 4u + lua_rawlen(state, -1); lua_pop(state, 1);
        lua_rawgeti(state, member, 2);
      }
      result = measure_result_value(state, -1, size, depth + 1u);
      lua_settop(state, payload);
    }
  } else if (tag == 11) {
    lua_rawgeti(state, payload, 1); *size += 4u + lua_rawlen(state, -1); lua_pop(state, 1);
    lua_rawgeti(state, payload, 2); result = measure_result_value(state, -1, size, depth + 1u);
  } else if (tag != 1 && tag != 2 && tag != 12) result = PDRV_ABI_FORBIDDEN;
  lua_settop(state, top);
  return result;
}

EMSCRIPTEN_KEEPALIVE int32_t pdrv_retained_result_encode(
    uint32_t value, uint8_t *output, uint32_t capacity) {
  RetainedResult *retained = (RetainedResult *)(uintptr_t)value;
  if (retained == NULL || !retained->pending) return PDRV_ABI_MALFORMED;
  lua_State *state = retained->invocation->state;
  lua_settop(state, retained->root);
  if (!retained->encoded_length) {
    uint64_t size = 10u;
    int measured;
    if (retained->call_status == LUA_OK) measured = measure_result_value(state, retained->root, &size, 0u);
    else {
      lua_getiuservalue(state, retained->root, 1); size += 4u + lua_rawlen(state, -1); lua_pop(state, 1);
      lua_getiuservalue(state, retained->root, 2); measured = measure_result_value(state, -1, &size, 0u); lua_pop(state, 1);
    }
    if (measured) return measured;
    retained->encoded_length = size;
  }
  if (retained->encoded_length > capacity) return PDRV_RESULT_OUTPUT;
  Writer writer = { output, 0u, capacity };
  int result = result_bytes(&writer, "PDRV", 4u);
  if (!result) result = result_u8(&writer, 1u);
  if (!result) result = result_u8(&writer, retained->call_status == LUA_OK ? 1u : 4u);
  if (!result) result = result_u32(&writer, 0u);
  if (!result && retained->call_status == LUA_OK)
    result = encode_result_value(state, retained->root, &writer, 0u);
  else if (!result) {
    lua_getiuservalue(state, retained->root, 1);
    size_t length; const char *name = lua_tolstring(state, -1, &length);
    if (!name || length > UINT32_MAX) result = PDRV_ENV_PROGRAM;
    else {
      result = result_u32(&writer, (uint32_t)length);
      if (!result) result = result_bytes(&writer, name, (uint32_t)length);
    }
    lua_pop(state, 1);
    if (!result) {
      lua_getiuservalue(state, retained->root, 2);
      result = encode_result_value(state, -1, &writer, 0u);
      lua_pop(state, 1);
    }
  }
  lua_settop(state, retained->root);
  if (result != 0) return result;
  patch_u32(&writer, 6u, writer.length - 10u);
  retained->pending = 0;
  return (int32_t)writer.length;
}

EMSCRIPTEN_KEEPALIVE int32_t pdrv_retained_result_dispatch(
    uint32_t value, const uint8_t *input, uint32_t length, uint8_t *output,
    uint32_t capacity, uint32_t remaining_fuel, uint32_t *fuel_used) {
  RetainedResult *retained = (RetainedResult *)(uintptr_t)value;
  if (retained == NULL || retained->pending || !remaining_fuel || !fuel_used)
    return PDRV_ABI_MALFORMED;
  InvocationHandle *handle = retained->invocation;
  int result = resource_failure(&handle->limits, LUA_OK);
  if (result) return result;
  handle->limits.fuel_used = 0;
  handle->limits.fuel_limit = remaining_fuel;
  *fuel_used = 0;
  retained_fuel_sink = fuel_used;
  lua_State *state = handle->state;
  lua_settop(state, 3);
  result = decode_program_invocation(state, input, length);
  if (result) goto done;
  lua_pushvalue(state, 4); lua_rawget(state, 3);
  if (!lua_isfunction(state, -1)) { result = PDRV_ENV_INVOCATION_EXPORT; goto done; }
  lua_pushvalue(state, 5);
  retained->call_status = lua_pcall(state, 1, 1, 0);
  result = resource_failure(&handle->limits, retained->call_status);
  if (result) goto done;
  if (retained->call_status == LUA_OK) {
    ConversionStack stack = { NULL, 0u, 0u };
    lua_pushcfunction(state, convert_result); lua_pushvalue(state, -2);
    lua_pushlightuserdata(state, &stack);
    int status = lua_pcall(state, 2, 2, 0);
    pdrv_scratch_free(stack.tables); // also on a protected allocator failure
    result = resource_failure(&handle->limits, status);
    if (result) goto done;
    if (status != LUA_OK) { result = program_error_code(state); goto done; }
    result = (int)lua_tointeger(state, -1); lua_pop(state, 1);
    if (result) goto done;
  } else {
    NamedFailure *failure = lua_type(state, -1) == LUA_TUSERDATA
      ? (NamedFailure *)lua_touserdata(state, -1) : NULL;
    if (!failure || failure->magic != PDRV_FAILURE_MAGIC) {
      result = program_error_code(state); goto done;
    }
  }
  retained->root = lua_gettop(state);
  retained->encoded_length = 0;
  retained->pending = 1;
  result = pdrv_retained_result_encode(value, output, capacity);
done:
  *fuel_used = handle->limits.fuel_used;
  retained_fuel_sink = NULL;
  return result;
}
