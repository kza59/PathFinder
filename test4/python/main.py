from animals import Cat, Dog


def dog_owner():
    Dog().speak()


def cat_owner():
    Cat().speak()


def main():
    dog_owner()
    cat_owner()


if __name__ == "__main__":
    main()
