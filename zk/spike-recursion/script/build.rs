fn main() {
    sp1_build::build_program_with_args("../inner", Default::default());
    sp1_build::build_program_with_args("../outer", Default::default());
}
