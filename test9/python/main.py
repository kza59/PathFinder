from admin import add_user
from importer import import_all


def main():
    add_user("ann", "31")
    import_all([["bob", "42"], ["eve", "abc"]])


if __name__ == "__main__":
    main()
