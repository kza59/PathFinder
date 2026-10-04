#include "importer.hpp"
#include "records.hpp"

int import_all(const std::vector<std::vector<std::string>> &rows)
{
    int total = 0;
    for (const auto &row : rows)
        total += load_record(row[0], row[1]).age;
    return total;
}
