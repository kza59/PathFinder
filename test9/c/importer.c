#include "importer.h"
#include "records.h"

int import_all(const char *rows[][2], int count)
{
    int total = 0;
    for (int i = 0; i < count; i++)
        total += load_record(rows[i][0], rows[i][1]).age;
    return total;
}
