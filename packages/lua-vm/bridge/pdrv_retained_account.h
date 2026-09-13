/* Selected retained bridge only. Legacy entry points retain their artifact.
 * A throwing host import poisons the instance. It must never be re-entered,
 * including through lua_close: an exception can interrupt Lua's C frames.
 * The host releases its reservation ledger when discarding that instance. */
#include <stdint.h>
#include <stdlib.h>
#include <stddef.h>
#include <string.h>
#include <emscripten/emscripten.h>
#define PDRV_RETAINED_ACCOUNTING 1
/* Survives a throwing native-account import without re-entering Lua. */
static uint32_t *retained_fuel_sink;

extern void pdrv_retained_work(uint32_t units)
    __attribute__((import_module("env"), import_name("pdrv_retained_work")));
extern uint32_t pdrv_retained_reserve(uint32_t capacity)
    __attribute__((import_module("env"), import_name("pdrv_retained_reserve")));
extern void pdrv_retained_release(uint32_t id)
    __attribute__((import_module("env"), import_name("pdrv_retained_release")));

typedef union ScratchHeader ScratchHeader;
union ScratchHeader {
  max_align_t alignment;
  struct { ScratchHeader *previous, *next; size_t capacity; uint32_t reservation; } value;
};
static ScratchHeader *scratch_head;

static void *pdrv_scratch_malloc(size_t capacity) {
  if (capacity > UINT32_MAX - sizeof(ScratchHeader)) return NULL;
  uint32_t reservation = pdrv_retained_reserve((uint32_t)(capacity + sizeof(ScratchHeader)));
  ScratchHeader *header = malloc(capacity + sizeof(ScratchHeader));
  if (!header) { pdrv_retained_release(reservation); return NULL; }
  header->value.previous = NULL;
  header->value.next = scratch_head;
  header->value.capacity = capacity;
  header->value.reservation = reservation;
  if (scratch_head) scratch_head->value.previous = header;
  scratch_head = header;
  return header + 1;
}
static void pdrv_scratch_free(void *pointer) {
  if (!pointer) return;
  ScratchHeader *header = (ScratchHeader *)pointer - 1;
  if (header->value.previous) header->value.previous->value.next = header->value.next;
  else scratch_head = header->value.next;
  if (header->value.next) header->value.next->value.previous = header->value.previous;
  uint32_t reservation = header->value.reservation;
  free(header);
  pdrv_retained_release(reservation);
}
static void *pdrv_scratch_realloc(void *pointer, size_t capacity) {
  if (!pointer) return pdrv_scratch_malloc(capacity);
  if (!capacity) { pdrv_scratch_free(pointer); return NULL; }
  if (capacity > UINT32_MAX - sizeof(ScratchHeader)) return NULL;
  ScratchHeader *old = (ScratchHeader *)pointer - 1;
  /* Reserve the possible realloc peak BEFORE realloc. It may move/copy;
   * charge that possible copy without replacing realloc's algorithm. */
  uint32_t reservation = pdrv_retained_reserve((uint32_t)(capacity + sizeof(ScratchHeader)));
  size_t copied = old->value.capacity < capacity ? old->value.capacity : capacity;
  pdrv_retained_work(1u + (uint32_t)(copied / 256u + (copied % 256u != 0)));
  ScratchHeader *previous = old->value.previous, *next = old->value.next;
  uint32_t released = old->value.reservation;
  ScratchHeader *header = realloc(old, capacity + sizeof(ScratchHeader));
  if (!header) { pdrv_retained_release(reservation); return NULL; }
  header->value.capacity = capacity;
  header->value.reservation = reservation;
  if (previous) previous->value.next = header; else scratch_head = header;
  if (next) next->value.previous = header;
  pdrv_retained_release(released);
  return header + 1;
}
static void *pdrv_scratch_calloc(size_t count, size_t width) {
  if (width && count > SIZE_MAX / width) return NULL;
  size_t capacity = count * width;
  /* Preserve calloc, rather than substituting a second allocation/copy. */
  if (capacity > UINT32_MAX - sizeof(ScratchHeader)) return NULL;
  uint32_t reservation = pdrv_retained_reserve((uint32_t)(capacity + sizeof(ScratchHeader)));
  pdrv_retained_work(1u + (uint32_t)(capacity / 256u + (capacity % 256u != 0)));
  ScratchHeader *header = calloc(1, capacity + sizeof(ScratchHeader));
  if (!header) { pdrv_retained_release(reservation); return NULL; }
  header->value.next = scratch_head;
  header->value.capacity = capacity;
  header->value.reservation = reservation;
  if (scratch_head) scratch_head->value.previous = header;
  scratch_head = header;
  return header + 1;
}
EMSCRIPTEN_KEEPALIVE void pdrv_retained_scratch_clear(void) {
  while (scratch_head) pdrv_scratch_free(scratch_head + 1);
}

#define PDRV_NATIVE_ITERATION() pdrv_retained_work(1u)
#define PDRV_NATIVE_BLOCKS(n) pdrv_retained_work(1u + (uint32_t)((n) / 256u + ((n) % 256u != 0)))
