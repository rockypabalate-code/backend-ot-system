class User {
  constructor({ id, firstName, middleName, lastName, name, email, passwordHash, role, status }) {
    this.id = id;
    this.firstName = firstName || '';
    this.middleName = middleName || '';
    this.lastName = lastName || '';
    this.name = name || [this.firstName, this.middleName, this.lastName].filter(Boolean).join(' ');
    this.email = email;
    this.passwordHash = passwordHash;
    this.role = role;
    this.status = status;
  }

  toJSON() {
    const user = {
      id: this.id,
      firstName: this.firstName,
      middleName: this.middleName,
      lastName: this.lastName,
      name: this.name,
      email: this.email,
      role: this.role,
      status: this.status,
    };

    if (this.impersonation) {
      user.impersonation = this.impersonation;
    }

    return user;
  }
}

module.exports = User;
