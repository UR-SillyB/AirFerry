#include <stdint.h>
#include <stddef.h>
void *airferry_receiver_create(uint64_t, uint64_t);
void airferry_receiver_destroy(void *);
uint64_t airferry_receiver_ingest(void *, const uint8_t *, size_t);
int32_t airferry_receiver_assemble(void *, uint8_t **, size_t *);
void airferry_buffer_free(uint8_t *, size_t);
size_t airferry_receiver_file_name(const void *, uint8_t *, size_t);
size_t airferry_receiver_progress_json(const void *, uint8_t *, size_t);
uint64_t airferry_receiver_file_size(const void *);
uint64_t airferry_receiver_crc32(const void *);
int32_t airferry_receiver_crc32_known(const void *);
int32_t airferry_receiver_is_segmented(const void *);
