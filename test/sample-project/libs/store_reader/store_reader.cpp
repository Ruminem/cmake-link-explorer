#include "store_reader.h"
#include "db_wrap.h"
#include <vector>
namespace store_reader {
static std::vector<int> g_tiles;
int OpenDatabase(const char* path) {
  g_tiles.assign(16, 0);
  return db_wrap::Open(path);
}
}  // namespace store_reader
