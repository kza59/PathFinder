from animals import Dog


def typed_owner(dog: Dog):
    return dog.speak()


def untyped_owner(pet):
    return pet.speak()  # pet's type is unknown, so the language server can't resolve speak here


def main():
    typed_owner(Dog())
    untyped_owner(Dog())


main()
