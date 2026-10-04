#include "admin.hpp"
#include "importer.hpp"

int main()
{
    add_user("ann", "31");
    return import_all({ { "bob", "42" }, { "eve", "abc" } }); // "abc" isn't a number
}
