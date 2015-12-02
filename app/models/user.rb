class User < ActiveRecord::Base
  devise :omniauthable, :omniauth_providers => [:google_oauth2]

  def authenticated?
    email.present? && password.present?
  end

  def add_omniauth_data(access_token)

    return self if authenticated?

    data = access_token.info

    update_attributes(name: data["name"],
      email: data["email"],
      image: data["image"],
      password: Devise.friendly_token[0,20]
    )

    self
  end

  def self.find_with_omniauth(access_token)
    data = access_token.info
    User.where(:email => data["email"]).first
  end
end
