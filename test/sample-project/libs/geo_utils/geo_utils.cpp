#include "geo_utils.h"
namespace geo_utils {
double Project(double latitude, double longitude) {
  return latitude * 111320.0 + longitude * 0.5;
}
}  // namespace geo_utils
