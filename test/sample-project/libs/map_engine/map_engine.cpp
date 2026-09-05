#include "map_engine.h"
#include "geo_utils.h"
#include "nds_reader.h"
namespace map_engine {
double Load(const char* database) {
  nds_reader::OpenDatabase(database);
  return geo_utils::Project(37.5, 127.0);
}
}  // namespace map_engine
