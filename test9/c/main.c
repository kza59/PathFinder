#include "admin.h"
#include "importer.h"

int main(void)
{
    add_user("ann", "31");
    const char *rows[][2] = { { "bob", "42" }, { "eve", 0 } }; /* eve's age is missing */
    return import_all(rows, 2);
}
